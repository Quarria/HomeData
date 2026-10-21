export function snapshotRecognitionFields<
  T extends {
    name: string;
    category: string;
    color: string;
    stylingAdvice: string;
    seasons: readonly string[];
    layers: readonly string[];
    scenes: readonly string[];
  },
>(form: T) {
  return {
    name: form.name,
    category: form.category,
    color: form.color,
    stylingAdvice: form.stylingAdvice,
    seasons: [...form.seasons],
    layers: [...form.layers],
    scenes: [...form.scenes],
  };
}
