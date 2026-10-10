import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureIncidentPolicy, detectNativeEventReversals, getIncidentPolicy, getIncident, getIncidentCoverage, getRepairControl,
  incidentDatabase, ingestObservation, listIncidents, readIncidentEvidence, recordMonitorCoverage,
  resumeIncidentRepairs, triageIncident, type IncidentPolicy,
} from '../lib/crm-incidents';
import { configureMonitor, tickMonitor } from '../lib/monitor';
import type { MonitorContact } from '../lib/monitor-types';
import { getMonitorEventStatus, receiveHubSpotMonitorEvents, receiveSalesforceMonitorEvents } from '../lib/monitor-events';
import type { MonitorSource } from '../lib/monitor-hubspot';

const directory=mkdtempSync(join(tmpdir(),'crm-incidents-'));
process.env.CONTROL_TOWER_SQLITE_PATH=join(directory,'incidents.db');
afterAll(()=>rmSync(directory,{recursive:true,force:true}));
afterEach(()=>vi.unstubAllEnvs());
const epoch=Date.now();
const at=(minutes:number)=>new Date(epoch+minutes*60_000).toISOString();
function contact(id:string,minute=0,properties:Record<string,string>={}):MonitorContact {
  return {provider:'hubspot',objectType:'Contact',id,updatedAt:at(minute),properties:{email:`${id}@example.test`,company:'Example',jobtitle:'Engineer',owner_id:'42',lifecyclestage:'lead',...properties}};
}
async function observe(scope:string,record:MonitorContact,phase:'baseline'|'changes'='changes',minutes=0) {
  return ingestObservation(scope,record,{phase,observedAt:at(minutes)});
}
async function policy(scope:string,overrides:Partial<IncidentPolicy>) {
  return configureIncidentPolicy(scope,{...await getIncidentPolicy(scope),...overrides});
}

describe('CRM incident evidence and correlation',()=>{
  it('retains harmless changes, groups a mass clear, excludes first baseline blanks, and does not invent attribution',async()=>{
    const scope='bulk';
    for(let i=0;i<40;i++)await observe(scope,contact(String(i),0,{jobtitle:i<5?'':'Engineer'}),'baseline');
    expect(await listIncidents(scope)).toEqual([]);
    await observe(scope,contact('30',1,{jobtitle:'Senior Engineer'}),'changes',1);
    for(let i=5;i<17;i++)await observe(scope,contact(String(i),2,{jobtitle:''}),'changes',2);
    const incidents=await listIncidents(scope);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({kind:'mass_field_clearing',affectedRecords:12,field:'jobtitle'});
    const detail=(await getIncident(scope,incidents[0].id))!;
    expect(detail.observations.some(o=>o.changes.some(c=>c.before==='Engineer'&&c.after===''))).toBe(true);
    expect(detail.observations.every(o=>o.source.kind==='poll'&&!o.source.actorId)).toBe(true);
    const db=await incidentDatabase();
    expect(await db.prepare("SELECT COUNT(*) AS count FROM crm_observations WHERE account_id=? AND changes_json LIKE '%Senior Engineer%'").bind(scope).first()).toEqual({count:1});
    expect(await db.prepare("SELECT COUNT(*) AS count FROM operation_notification_outbox WHERE event_key LIKE 'incident:bulk:%'").first()).toEqual({count:1});
    const alert=await db.prepare("SELECT payload_json FROM operation_notification_outbox WHERE event_key LIKE 'incident:bulk:%'").first<{payload_json:string}>();
    expect(new URL(JSON.parse(alert!.payload_json).path,'http://fixture').searchParams.get('account')).toBe('bulk');
  });

  it('deduplicates events, ignores out-of-order values, and preserves native IDs across objects and providers',async()=>{
    await observe('order',contact('same',1),'baseline',1);
    await observe('order',contact('same',3,{company:'Latest'}),'changes',3);
    expect(await observe('order',contact('same',2,{company:'Old'}),'changes',4)).toMatchObject({accepted:false,reason:'out_of_order'});
    expect(await observe('order',contact('same',3,{company:'Latest'}),'changes',5)).toMatchObject({accepted:false,reason:'duplicate'});
    await observe('order',{...contact('same',1),objectType:'Company',properties:{name:'Company',domain:'company.test'}},'baseline',1);
    await observe('salesforce_org',{...contact('same',1),provider:'salesforce'},'baseline',1);
    const db=await incidentDatabase();
    const rows=(await db.prepare('SELECT account_id,record_key,payload_json FROM crm_observed_records WHERE record_id=? ORDER BY account_id,record_key').bind('same').all<{account_id:string;record_key:string;payload_json:string}>()).results;
    expect(rows.map(r=>[r.account_id,r.record_key])).toEqual([['order','Company:same'],['order','same'],['salesforce_org','Contact:same']]);
    expect(JSON.parse(rows[1].payload_json).properties.company).toBe('Latest');
  });

  it('holds conflicting values with equal native timestamps and reports an incomplete baseline explicitly',async()=>{
    const scope='same-time';await observe(scope,contact('one',1),'baseline',1);
    expect(await observe(scope,contact('one',1,{jobtitle:'Unordered'}),'changes',2)).toMatchObject({accepted:false,reason:'ambiguous_timestamp'});
    const db=await incidentDatabase();
    const row=await db.prepare('SELECT payload_json FROM crm_observed_records WHERE account_id=? AND record_key=?').bind(scope,'one').first<{payload_json:string}>();
    expect(JSON.parse(row!.payload_json).properties.jobtitle).toBe('Engineer');
    expect((await listIncidents(scope))[0]).toMatchObject({kind:'coverage',field:'timestamp_order'});
    await recordMonitorCoverage(scope,{status:'healthy',phase:'baseline',scanned:1});
    expect((await getIncidentCoverage(scope)).status).toBe('baseline');
    expect(await observe(scope,contact('one',3,{jobtitle:'Ordered'}),'changes',3)).toMatchObject({accepted:true,changedFields:1});
  });

  it('records newly readable fields as first observations, without inventing empty before values or timestamp conflicts',async()=>{
    const scope='readable-fields';
    await observe(scope,{...contact('company'),objectType:'Company',properties:{name:'Example'}},'baseline');
    await observe(scope,{...contact('company'),objectType:'Company',properties:{name:'Example',domain:'example.test'}},'baseline',1);
    expect(await listIncidents(scope)).toEqual([]);
    const db=await incidentDatabase();const row=await db.prepare('SELECT payload_json FROM crm_observed_records WHERE account_id=? AND record_key=?').bind(scope,'Company:company').first<{payload_json:string}>();
    expect(JSON.parse(row!.payload_json).properties.domain).toBe('example.test');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM crm_observations WHERE account_id=? AND changes_json!='[]'").bind(scope).first()).toEqual({count:0});
  });

  it('holds planned changes out of detection while preserving source-linked observed changes',async()=>{
    const scope='planned';
    await policy(scope,{minimumRecords:2,plannedChanges:[{id:'migration',objectType:'Contact',fields:['jobtitle'],until:at(30),reason:'Approved job title cleanup'}]});
    for(const id of ['a','b'])await observe(scope,contact(id),'baseline');
    for(const id of ['a','b'])await ingestObservation(scope,{...contact(id,2,{jobtitle:''}),source:{kind:'hubspot_webhook',eventId:`event-${id}`,actorId:'native-actor'}},{phase:'changes',observedAt:at(2)});
    expect(await listIncidents(scope)).toEqual([]);
    const db=await incidentDatabase();
    const rows=(await db.prepare("SELECT source_json,suppressed_json FROM crm_observations WHERE account_id=? AND changes_json!='[]'").bind(scope).all<{source_json:string;suppressed_json:string}>()).results;
    expect(rows).toHaveLength(2);expect(JSON.parse(rows[0].source_json)).toMatchObject({actorId:'native-actor'});
    expect(JSON.parse(rows[0].suppressed_json)).toEqual(['jobtitle']);
  });

  it('pauses repairs when repeated changes return to earlier values',async()=>{
    const scope='reversals';await policy(scope,{reversalsBeforePause:2});
    await observe(scope,contact('one',0,{jobtitle:'A'}),'baseline');
    for(let i=1;i<=4;i++)await observe(scope,contact('one',i,{jobtitle:i%2?'B':'A'}),'changes',i);
    expect((await listIncidents(scope)).find(i=>i.kind==='value_reversal')).toMatchObject({affectedRecords:1});
    expect(await getRepairControl(scope)).toMatchObject({paused:true});
    await resumeIncidentRepairs(scope);expect((await getRepairControl(scope)).paused).toBe(false);
  });

  it('starts an expectation deadline at the unmet condition, respects company coverage, and treats missing properties as gaps',async()=>{
    const scope='expectations';await policy(scope,{expectations:[{id:'routing',objectType:'Contact',whenField:'lifecyclestage',whenValues:['salesqualifiedlead'],requiredField:'owner_id',deadlineMinutes:5}],relationships:[{id:'company-link',objectType:'Contact',field:'company_id',targetType:'Company',required:true}]});
    await observe(scope,contact('lead',0,{company_id:'missing'}),'baseline');
    await observe(scope,contact('lead',30,{lifecyclestage:'salesqualifiedlead',owner_id:'',company_id:'missing'}),'changes',30);
    expect(await listIncidents(scope)).toEqual([]);
    await observe(scope,contact('lead',30,{lifecyclestage:'salesqualifiedlead',owner_id:'',company_id:'missing'}),'changes',34);
    expect(await listIncidents(scope)).toEqual([]);
    await recordMonitorCoverage(scope,{status:'healthy',phase:'changes',observedAt:at(35),scanned:2,objectTypes:['Contact','Company']});
    await observe(scope,contact('lead',30,{lifecyclestage:'salesqualifiedlead',owner_id:'',company_id:'missing'}),'changes',36);
    expect((await listIncidents(scope)).map(i=>i.kind).sort()).toEqual(['expectation','relationship']);
    const omitted=contact('lead',40,{lifecyclestage:'salesqualifiedlead',owner_id:'',company_id:'missing'});delete omitted.properties.jobtitle;
    await observe(scope,omitted,'changes',40);
    expect((await listIncidents(scope)).some(i=>i.kind==='coverage')).toBe(true);
    expect((await listIncidents(scope)).some(i=>i.kind==='mass_field_clearing')).toBe(false);
  });

  it('reports unevaluable configured rules without inventing blanks or resetting an existing deadline',async()=>{
    const scope='policy-coverage';await policy(scope,{expectations:[{id:'route',objectType:'Contact',whenField:'lifecyclestage',whenValues:['salesqualifiedlead'],requiredField:'owner_id',deadlineMinutes:5},{id:'custom',objectType:'Contact',whenField:'custom_status',whenValues:['ready'],requiredField:'owner_id',deadlineMinutes:5}],relationships:[{id:'required-company',objectType:'Contact',field:'company_id',targetType:'Company',required:true}]});
    await observe(scope,contact('one',0,{lifecyclestage:'salesqualifiedlead',owner_id:''}),'baseline');
    const db=await incidentDatabase();const original=await db.prepare('SELECT since FROM crm_expectation_clocks WHERE account_id=? AND rule_id=?').bind(scope,'route').first();
    const unknown=contact('one',1,{lifecyclestage:'salesqualifiedlead'});delete unknown.properties.owner_id;
    await observe(scope,unknown,'changes',1);
    expect(await db.prepare('SELECT since FROM crm_expectation_clocks WHERE account_id=? AND rule_id=?').bind(scope,'route').first()).toEqual(original);
    const findings=await listIncidents(scope);
    expect(findings.filter(item=>item.kind==='coverage').map(item=>item.field)).toEqual(expect.arrayContaining(['expectation:custom','expectation:route','relationship:required-company']));
    expect(findings.some(item=>item.kind==='relationship'||item.kind==='expectation')).toBe(false);
  });

  it('supports multiple native associations and never chooses an arbitrary primary company',async()=>{
    const scope='associations';await policy(scope,{relationships:[{id:'deal-companies',objectType:'Deal',field:'company_ids',targetType:'Company',required:true}]});
    for(const id of ['co-one','co-two'])await observe(scope,{...contact(id),objectType:'Company',properties:{name:id}},'baseline');
    await recordMonitorCoverage(scope,{status:'healthy',phase:'changes',scanned:2,objectTypes:['Deal','Company']});
    await observe(scope,{...contact('deal-one'),objectType:'Deal',properties:{company_ids:'["co-one","co-two"]'}},'changes');
    expect(await listIncidents(scope)).toEqual([]);
    await observe(scope,{...contact('deal-two'),objectType:'Deal',properties:{company_ids:'["co-one","co-missing"]'}},'changes');
    const incident=(await listIncidents(scope))[0];expect(incident).toMatchObject({kind:'relationship',affectedRecords:1});
    expect(incident.evidence.targetIds).toEqual(['co-missing']);
    expect((await readIncidentEvidence(scope,incident.id))?.relatedRecords.map(r=>r.record.id)).toEqual(['co-one']);
  });

  it('saves a structured resolution, retains its evidence for investigation, and does not treat it as a new policy',async()=>{
    const scope='resolution';await policy(scope,{minimumRecords:2});
    for(const id of ['a','b'])await observe(scope,contact(id),'baseline');
    for(const id of ['a','b'])await observe(scope,contact(id,1,{jobtitle:''}),'changes',1);
    const initial=(await listIncidents(scope))[0];
    const detail=await triageIncident(scope,{id:initial.id,status:'resolved',assignee:'Operations',note:'Integration owner confirmed the planned change.',resolution:'intentional_change'});
    expect(detail).toMatchObject({status:'resolved',resolution:'intentional_change',assignee:'Operations'});
    expect(detail.timeline.some(item=>item.detail.includes('intentional_change'))).toBe(true);
    const evidence=(await readIncidentEvidence(scope,initial.id))!;
    expect(evidence.records).toHaveLength(2);expect(evidence.priorResolutions[0].id).toBe(initial.id);
    expect(evidence.policy.version).toBe(2);
    await expect(triageIncident('different',{id:initial.id,status:'resolved',assignee:'',note:'',resolution:'inconclusive'})).rejects.toThrow('not found');
  });

  it('rolls back incident and new observation if notification intent cannot be saved, then recovers on replay',async()=>{
    const scope='atomic';await policy(scope,{minimumRecords:2});
    for(const id of ['a','b'])await observe(scope,contact(id),'baseline');
    await observe(scope,contact('a',1,{jobtitle:''}),'changes',1);
    const db=await incidentDatabase();
    await db.prepare("CREATE TRIGGER reject_incident_alert BEFORE INSERT ON operation_notification_outbox WHEN NEW.event_key LIKE 'incident:atomic:%' BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END").run();
    await expect(observe(scope,contact('b',1,{jobtitle:''}),'changes',1)).rejects.toThrow('fixture transaction failure');
    expect(await listIncidents(scope)).toEqual([]);
    const before=await db.prepare('SELECT payload_json FROM crm_observed_records WHERE account_id=? AND record_key=?').bind(scope,'b').first<{payload_json:string}>();
    expect(JSON.parse(before!.payload_json).properties.jobtitle).toBe('Engineer');
    await db.prepare('DROP TRIGGER reject_incident_alert').run();
    await observe(scope,contact('b',1,{jobtitle:''}),'changes',1);
    expect(await listIncidents(scope)).toHaveLength(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM operation_notification_outbox WHERE event_key LIKE 'incident:atomic:%'").first()).toEqual({count:1});
  });

  it('flags structural deal problems and duplicate candidates without rejecting custom stages or legitimate negative amounts',async()=>{
    const scope='business';
    await observe(scope,{...contact('deal-good'),objectType:'Deal',properties:{amount:'-20.50',stage:'bespoke_stage',close_date:'2026-10-10'}},'baseline');
    expect(await listIncidents(scope)).toEqual([]);
    await observe(scope,{...contact('deal-bad'),objectType:'Deal',properties:{amount:'$1,2x',stage:'bespoke_stage',close_date:'2026-02-30'}},'baseline');
    await observe(scope,{...contact('co-a'),objectType:'Company',properties:{domain:'Example.test'}},'baseline');
    await observe(scope,{...contact('co-b'),objectType:'Company',properties:{domain:' example.test '}},'baseline');
    const findings=await listIncidents(scope);
    expect(findings.filter(i=>i.kind==='invalid_value')).toHaveLength(2);
    expect(findings.find(i=>i.kind==='duplicate_candidate')).toMatchObject({affectedRecords:2,objectType:'Company'});
  });

  it('retains last success separately from failure, derives stale runner health, and bounds observation retention',async()=>{
    const scope='health';
    await recordMonitorCoverage(scope,{status:'healthy',phase:'changes',scanned:5,observedAt:at(-40),staleAfterSeconds:900});
    expect((await getIncidentCoverage(scope)).status).toBe('stale');
    await recordMonitorCoverage(scope,{status:'degraded',phase:'changes',scanned:0,observedAt:at(0),error:'Fixture authorization expired.'});
    expect(await getIncidentCoverage(scope)).toMatchObject({status:'degraded',lastSuccessAt:at(-40),lastCheckedAt:at(0)});
    await policy(scope,{maxObservations:100});
    for(let i=0;i<110;i++)await observe(scope,contact('one',i,{jobtitle:`Value ${i}`}),'changes',i);
    const db=await incidentDatabase();expect(await db.prepare('SELECT COUNT(*) AS count FROM crm_observations WHERE account_id=?').bind(scope).first()).toEqual({count:100});
  });
});

describe('repair limits integrated with the real monitor executor',()=>{
  it('uses durable account budgets, does not write once paused, and does not reset spend when resumed',async()=>{
    const scope='budget';await policy(scope,{repairLimitPerHour:2});
    const records=new Map(['a','b','c'].map(id=>[id,contact(id,0,{company:' Example '})]));
    let writes=0;
    const source:MonitorSource={
      list:async()=>({contacts:[...records.values()],after:null}),changes:async()=>({contacts:[...records.values()],after:null,total:3}),
      read:async(id)=>structuredClone(records.get(id)!),patch:async(id,properties)=>{writes++;const old=records.get(id)!;records.set(id,{...old,updatedAt:at(1),properties:{...old.properties,...properties}});},
    };
    await configureMonitor(scope,{enabled:true,automaticRepairs:true,intervalSeconds:300,defaultAssignee:'Operations'});
    await tickMonitor(scope,'fixture',{force:true,source});
    expect(writes).toBe(2);expect((await getRepairControl(scope)).paused).toBe(true);
    await tickMonitor(scope,'fixture',{force:true,source});expect(writes).toBe(2);
    await resumeIncidentRepairs(scope);await tickMonitor(scope,'fixture',{force:true,source});expect(writes).toBe(2);
    expect((await listIncidents(scope)).find(i=>i.kind==='repair_pause')).toBeTruthy();
  });
  it('halts repeated repairs to the same record even below the account budget',async()=>{
    const scope='repeated-repair';
    let record=contact('one',0,{company:' Example '});let writes=0;
    const source:MonitorSource={list:async()=>({contacts:[record],after:null}),changes:async()=>({contacts:[record],after:null,total:1}),read:async()=>structuredClone(record),patch:async(_id,properties)=>{writes++;record={...record,updatedAt:new Date(Date.parse(record.updatedAt)+1000).toISOString(),properties:{...record.properties,...properties}};}};
    await configureMonitor(scope,{enabled:true,automaticRepairs:true,intervalSeconds:300,defaultAssignee:'Operations'});
    await tickMonitor(scope,'fixture',{force:true,source});
    for(let round=1;round<=2;round++){
      record={...record,updatedAt:at(round),properties:{...record.properties,company:' Example '}};
      await tickMonitor(scope,'fixture',{force:true,source});
    }
    expect(writes).toBe(2);expect(await getRepairControl(scope)).toMatchObject({paused:true});
    expect((await listIncidents(scope)).find(i=>i.kind==='repair_pause')?.evidence.reason).toContain('recurrence');
  });

  it('restarts a full baseline when object access returns and cannot declare coverage healthy halfway through it',async()=>{
    const scope='restored-capability';let restored=false;const cursors:(string|null)[]=[];
    const source:MonitorSource={
      capabilities:async()=>[{objectType:'Contact',status:'available',fields:['email'],missingFields:[],detail:'Readable'},
        {objectType:'Company',status:restored?'available':'unavailable',fields:restored?['name','domain']:[],missingFields:restored?[]:['name','domain'],detail:restored?'Readable':'Permission denied'}],
      list:async(after)=>{cursors.push(after);return restored?(after?{contacts:[{...contact('company'),objectType:'Company',properties:{name:'Older company',domain:'older.test'}}],after:null}:{contacts:[contact('person')],after:'companies'}):{contacts:[contact('person')],after:null};},
      changes:async()=>{throw new Error('Restored old objects are absent from a changes-only window');},
      read:async()=>contact('person'),patch:async()=>{throw new Error('No writes expected');},
    };
    await configureMonitor(scope,{enabled:true,automaticRepairs:false,intervalSeconds:300,defaultAssignee:'Operations'});
    await tickMonitor(scope,'fixture',{force:true,source});
    expect((await getIncidentCoverage(scope)).status).toBe('degraded');
    restored=true;
    expect((await tickMonitor(scope,'fixture',{force:true,source})).phase).toBe('baseline');
    expect((await getIncidentCoverage(scope)).status).toBe('baseline');
    expect((await tickMonitor(scope,'fixture',{force:true,source})).phase).toBe('changes');
    expect((await getIncidentCoverage(scope)).status).toBe('healthy');
    expect(cursors).toEqual([null,null,'companies']);
  });

  it('checks unchanged routing deadlines and keeps held native events visible as degraded coverage',async()=>{
    const scope='deadline-tick';await policy(scope,{expectations:[{id:'route',objectType:'Contact',whenField:'lifecyclestage',whenValues:['salesqualifiedlead'],requiredField:'owner_id',deadlineMinutes:5}]});
    const record=contact('one',0,{lifecyclestage:'salesqualifiedlead',owner_id:''});
    const source:MonitorSource={list:async()=>({contacts:[record],after:null}),changes:async()=>({contacts:[],after:null,total:0}),read:async()=>record,patch:async()=>{throw new Error('No writes allowed');}};
    await configureMonitor(scope,{enabled:true,automaticRepairs:false,intervalSeconds:300,defaultAssignee:'Operations'});
    await tickMonitor(scope,'fixture',{force:true,source});
    const db=await incidentDatabase();
    await db.prepare('UPDATE crm_expectation_clocks SET since=? WHERE account_id=?').bind(at(-10),scope).run();
    await tickMonitor(scope,'fixture',{force:true,source});
    expect((await listIncidents(scope)).find(i=>i.kind==='expectation')).toBeTruthy();
    await getMonitorEventStatus(scope);
    await db.prepare('INSERT INTO monitor_native_events(id,account_id,payload_json,received_at,held,attempts) VALUES(?,?,?,?,1,3)').bind('held-fixture',scope,JSON.stringify({id:'held-fixture',scope,provider:'hubspot',objectType:'Contact',recordId:'missing',kind:'refresh',occurredAt:at(0),source:{kind:'hubspot_webhook',eventId:'held-fixture',attribution:'refresh_trigger_only'}}),at(0)).run();
    await tickMonitor(scope,'fixture',{force:true,source});
    expect(await getIncidentCoverage(scope)).toMatchObject({status:'degraded'});
    expect((await getIncidentCoverage(scope)).error).toContain('held');
  });

});


describe('native event-only reversal evidence',()=>{
  const secret='synthetic-native-sequence-secret-32-characters';
  async function events(provider:'hubspot'|'salesforce',accountId:string,recordId:string,values:string[],times?:number[]) {
    const timestamp=String(Date.now());const start=Date.now()-60_000;
    if(provider==='hubspot') {
      const url='https://control-tower.example.test/api/control-tower/events/hubspot';
      vi.stubEnv('HUBSPOT_MONITOR_CLIENT_SECRET',secret);vi.stubEnv('HUBSPOT_MONITOR_PORTAL_ID',accountId);vi.stubEnv('HUBSPOT_MONITOR_WEBHOOK_URL',url);
      const body=JSON.stringify(values.map((value,index)=>({portalId:Number(accountId),eventId:index+1,subscriptionId:1,subscriptionType:'contact.propertyChange',objectId:recordId,occurredAt:times?.[index]??start+index*1000,propertyName:'jobtitle',propertyValue:value})));
      const signature=createHmac('sha256',secret).update(`POST${url}${body}${timestamp}`).digest('base64');
      const request=()=>new Request(url,{method:'POST',body,headers:{'x-hubspot-request-timestamp':timestamp,'x-hubspot-signature-v3':signature}});
      await receiveHubSpotMonitorEvents(request());await receiveHubSpotMonitorEvents(request());
    } else {
      const url='https://control-tower.example.test/api/control-tower/events/salesforce';
      vi.stubEnv('CONTROL_TOWER_CDC_RELAY_SECRET',secret);vi.stubEnv('SALESFORCE_MONITOR_ORG_ID',accountId);
      const body=JSON.stringify({organizationId:accountId,channel:'/data/ChangeEvents',replayId:'native-sequence',previousReplayId:null,events:values.map((value,index)=>({ChangeEventHeader:{entityName:'Lead',recordIds:[recordId],changeType:'UPDATE',transactionKey:`native-${index}`,sequenceNumber:1,commitTimestamp:times?.[index]??start+index*1000,changedFields:['Title']},Title:value}))});
      const signature=createHmac('sha256',secret).update(`${timestamp}\nPOST\n/api/control-tower/events/salesforce\n${body}`).digest('hex');
      const request=()=>new Request(url,{method:'POST',body,headers:{'x-control-tower-timestamp':timestamp,'x-control-tower-signature':signature}});
      await receiveSalesforceMonitorEvents(request());await receiveSalesforceMonitorEvents(request());
    }
  }
  it.each(['hubspot','salesforce'] as const)('contains repeated signed %s returns even when every fresh read has the same final value',async(provider)=>{
    const accountId=provider==='hubspot'?'771001':'00D000000000771';const scope=provider==='hubspot'?accountId:`salesforce_${accountId}`;
    const id=provider==='hubspot'?'771':'00Q000000000771';const objectType=provider==='hubspot'?'Contact':'Lead';
    await policy(scope,{reversalsBeforePause:2});
    const current={...contact(id,0,{company:' Example ',jobtitle:'A'}),provider,objectType} as MonitorContact;
    let writes=0;const source:MonitorSource={provider,accountId,list:async()=>({contacts:[current],after:null}),changes:async()=>({contacts:[],after:null,total:0}),read:async()=>structuredClone(current),patch:async()=>{writes++;}};
    await configureMonitor(scope,{enabled:true,automaticRepairs:false,intervalSeconds:300,defaultAssignee:'Operations'});
    await tickMonitor(scope,'fixture',{force:true,source});
    await events(provider,accountId,id,['A','B','A','B']);
    await configureMonitor(scope,{enabled:true,automaticRepairs:true,intervalSeconds:300,defaultAssignee:'Operations'});
    await tickMonitor(scope,'fixture',{force:true,source});
    expect(writes).toBe(0);expect((await getRepairControl(scope)).paused).toBe(true);
    const reversal=(await listIncidents(scope)).find(item=>item.kind==='value_reversal')!;
    expect(reversal.evidence).toMatchObject({evidenceSource:'native_event_reported_values',returns:2,threshold:2,field:'jobtitle'});
    expect((reversal.evidence.reportedSequence as unknown[])).toHaveLength(4);
    const db=await incidentDatabase();const key=provider==='hubspot'?id:`Lead:${id}`;
    expect(JSON.parse((await db.prepare('SELECT payload_json FROM crm_observed_records WHERE account_id=? AND record_key=?').bind(scope,key).first<{payload_json:string}>())!.payload_json).properties.jobtitle).toBe('A');
    expect(await db.prepare("SELECT COUNT(*) AS count FROM crm_observations WHERE account_id=? AND changes_json!='[]'").bind(scope).first()).toEqual({count:0});
    const outbox=await db.prepare('SELECT COUNT(*) AS count FROM operation_notification_outbox WHERE event_key LIKE ?').bind(`incident:${scope}:%`).first();
    await resumeIncidentRepairs(scope);await detectNativeEventReversals(scope,[key]);
    expect((await getRepairControl(scope)).paused).toBe(false);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM operation_notification_outbox WHERE event_key LIKE ?').bind(`incident:${scope}:%`).first()).toEqual(outbox);
  });
  it('processes ready native hints before a long polling deadline while preserving monitoring opt-out',async()=>{
    const scope='773001';const current=contact('773');const read=vi.fn(async()=>current);
    const source:MonitorSource={list:async()=>({contacts:[current],after:null}),changes:async()=>({contacts:[],after:null,total:0}),read,patch:async()=>{throw new Error('No writes expected');}};
    await configureMonitor(scope,{enabled:true,automaticRepairs:false,intervalSeconds:3600,defaultAssignee:'Operations'});
    await tickMonitor(scope,'fixture',{force:true,source});
    const db=await incidentDatabase();
    await db.prepare('UPDATE monitor_accounts SET next_check_at=? WHERE account_id=?').bind(new Date(Date.now()+3_600_000).toISOString(),scope).run();
    await events('hubspot',scope,'773',['A']);
    await tickMonitor(scope,'fixture',{source});
    expect(read).toHaveBeenCalledTimes(1);expect((await getMonitorEventStatus(scope)).pending).toBe(0);
    await configureMonitor(scope,{enabled:false,automaticRepairs:false,intervalSeconds:3600,defaultAssignee:'Operations'});
    await events('hubspot',scope,'773',['B']);await tickMonitor(scope,'fixture',{source});
    expect(read).toHaveBeenCalledTimes(1);expect((await getMonitorEventStatus(scope)).pending).toBe(1);
  });

  it('schedules a bounded native backlog promptly without tight-looping held events',async()=>{
    const scope='773002';const current=contact('773');
    const source:MonitorSource={list:async()=>({contacts:[current],after:null}),changes:async()=>({contacts:[],after:null,total:0}),read:async()=>current,patch:async()=>{throw new Error('No writes expected');}};
    await configureMonitor(scope,{enabled:true,automaticRepairs:false,intervalSeconds:3600,defaultAssignee:'Operations'});
    await tickMonitor(scope,'fixture',{force:true,source});
    await events('hubspot',scope,'773',Array.from({length:11},(_,index)=>String(index)));
    const first=await tickMonitor(scope,'fixture',{source});
    expect((await getMonitorEventStatus(scope)).pending).toBe(1);
    expect(Date.parse(first.nextCheckAt!)-Date.now()).toBeLessThan(2000);
    const db=await incidentDatabase();await db.prepare('UPDATE monitor_native_events SET held=1 WHERE account_id=? AND processed_at IS NULL').bind(scope).run();
    const second=await tickMonitor(scope,'fixture',{source,force:true});
    expect(Date.parse(second.nextCheckAt!)-Date.now()).toBeGreaterThan(3_590_000);
  });

  it('excludes a single correction, ambiguous ties, and planned native field changes',async()=>{
    for(const [scope,values,times,planned] of [
      ['772001',['A','B','A'],undefined,false],
      ['772002',['A','B','A','B'],[Date.now()-60000,Date.now()-59000,Date.now()-59000,Date.now()-57000],false],
      ['772003',['A','B','A','B'],undefined,true],
    ] as const) {
      await policy(scope,{reversalsBeforePause:2,...(planned?{plannedChanges:[{id:'migration',objectType:'Contact' as const,fields:['jobtitle'],until:new Date(Date.now()+60000).toISOString(),reason:'Planned title correction'}]}:{})});
      await events('hubspot',scope,'772',[...values],times?[...times]:undefined);
      expect(await detectNativeEventReversals(scope,['772'])).toEqual([]);
      expect(await listIncidents(scope)).toEqual([]);expect((await getRepairControl(scope)).paused).toBe(false);
    }
  });
});
