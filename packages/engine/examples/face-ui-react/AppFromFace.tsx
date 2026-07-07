import React from 'react';
import type { FaceUiDoc } from '@userface/engine/face-ui';
import { FaceUi, createFaceUiRegistry } from '@userface/engine/face-ui';

/**
 * This file is intentionally dependency-free (no Components import here).
 * In a real app, map these to your UI library components.
 */
const Button: React.FC<any> = (p) => <button {...p} />;
const Text: React.FC<any> = (p) => <div {...p}>{p.text}</div>;
const Panel: React.FC<any> = (p) => (
  <div style={{ border: '1px solid #ccc', padding: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
      <div>{p.left}</div>
      <div>{p.right}</div>
    </div>
    <div>{p.children}</div>
  </div>
);

const registry = createFaceUiRegistry({
  Button,
  Text,
  Panel,
});

export function AppFromFace(props: { doc: FaceUiDoc }) {
  return (
    <FaceUi
      doc={props.doc}
      props={{ right: '…right slot…' }}
      context={{}}
      registry={registry}
      actions={{
        dispatch: (action: string, args: any) => {
          if (action === 'log') console.log('[face action]', args);
        },
      }}
    />
  );
}

