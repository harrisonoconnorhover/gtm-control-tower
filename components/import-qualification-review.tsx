'use client';

import { useState } from 'react';
import type { LiveContactState } from '@/lib/live-control-tower';
import { WebsiteCheckReview, type WebsiteReviewSnapshot } from './website-check-review';
import { PomadeQualificationReview } from './pomade-qualification-review';

type Props = { contacts: LiveContactState[]; workspaceId: string | null; accessKey: string; disabled?: boolean; suppressionState?: 'loading' | 'error' | 'ready' };

export function ImportQualificationReview(props: Props) {
  return <QualificationPanels key={`${props.workspaceId}:${props.accessKey}`} {...props} />;
}

function QualificationPanels(props: Props) {
  const [websites, setWebsites] = useState<WebsiteReviewSnapshot>({ checks: [], state: 'loading' });
  return <>
    <WebsiteCheckReview {...props} onObservations={setWebsites} />
    <PomadeQualificationReview {...props} websites={websites} />
  </>;
}
