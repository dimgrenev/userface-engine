export function getComponentFaceJsonFileNames(componentName: string): string[] {
  const name = String(componentName || '').trim();
  return [
    ...(name ? [`${name}.json`, `${name}.face.json`] : []),
    'face.json',
    'face.face.json',
  ];
}
