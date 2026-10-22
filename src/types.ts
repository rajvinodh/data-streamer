export interface StartTextCollectionParams {
  name: string;
  locator: {
    using: string;
    value: string;
  };
  intervalMs?: number;
}

export interface StopTextCollectionParams {
  name: string;
}

export interface TextSample {
  timestamp: number;
  text: string;
  elapsed: number;
}

export interface TextCollectionResult {
  name: string;
  samples: TextSample[];
  startedAt: number;
  stoppedAt: number;
  durationMs: number;
  sampleCount: number;
  totalSkipped: number;
}

export interface ActiveCollection {
  name: string;
  elementId: string;
  subscriptionId: string;
  intervalMs: number;
  startedAt: number;
  samples: TextSample[];
  totalSkipped: number;
  maxDurationTimer: ReturnType<typeof setTimeout> | null;
}
