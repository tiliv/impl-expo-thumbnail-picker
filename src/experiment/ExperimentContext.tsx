import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { resolveThumbnailSettings, type ResolvedThumbnailSettings } from '../core/settings';
import { expoProvider } from '../adapters/expoProvider';
import { ExperimentWorld } from './world';
import { DEFAULT_SCENARIO, loadScenario, type Scenario } from './scenarios';

interface ExperimentValue extends ResolvedThumbnailSettings {
  world: ExperimentWorld;
  scenario: Scenario;
  setScenario(scenario: Scenario): void;
  revision: number;
}

const ExperimentContext = createContext<ExperimentValue | null>(null);

export function ExperimentProvider({ children }: { children: React.ReactNode }) {
  const worldRef = useRef<ExperimentWorld | null>(null);
  if (worldRef.current === null) {
    worldRef.current = new ExperimentWorld(expoProvider);
    loadScenario(worldRef.current, DEFAULT_SCENARIO);
  }
  const world = worldRef.current;

  const [scenario, setScenarioState] = useState<Scenario>(DEFAULT_SCENARIO);
  const revision = useSyncExternalStore(world.subscribe, world.getRevision, world.getRevision);

  const resolved = useMemo(() => resolveThumbnailSettings(world.stateStore), [world, revision]);

  // Resolve anything that has no result yet. The world caches, and clears the
  // cache whenever settings, capabilities or a user pick change — so this
  // re-runs exactly when the answer could have changed.
  useEffect(() => {
    for (const video of world.videos()) {
      if (!world.resolution(video.id)) void world.resolve(video);
    }
  }, [world, revision]);

  const value = useMemo<ExperimentValue>(
    () => ({
      ...resolved,
      world,
      revision,
      scenario,
      setScenario(next: Scenario) {
        loadScenario(world, next);
        setScenarioState(next);
      },
    }),
    [resolved, world, revision, scenario],
  );

  return <ExperimentContext.Provider value={value}>{children}</ExperimentContext.Provider>;
}

export function useExperiment(): ExperimentValue {
  const value = useContext(ExperimentContext);
  if (!value) throw new Error('useExperiment must be used inside <ExperimentProvider>');
  return value;
}
