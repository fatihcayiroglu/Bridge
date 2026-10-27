export type StartupMarker = 'js_entry' | 'first_layout' | 'first_interaction';
export declare function createStartupMetrics(clock?: () => number): {
  mark(name: StartupMarker): boolean;
  snapshot(): Partial<Record<StartupMarker, number>>;
};
