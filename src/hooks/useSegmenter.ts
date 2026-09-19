import { useSyncExternalStore } from 'react';
import { segmenter } from '../lib/segmenter';

export function useSegmenter() {
  return useSyncExternalStore(segmenter.subscribe, segmenter.getState);
}
