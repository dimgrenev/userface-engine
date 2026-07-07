# face-ui-react example

This folder is shipped as reference for users of `@userface/engine`.

## What it shows
- `face.json`: a minimal face schema v1 UI tree document
- `AppFromFace.tsx`: React usage with a component registry + actions

## How to use in your app
1) Put the JSON somewhere (bundle it, fetch it, or load from disk).
2) Parse it to `FaceUiDoc`.
3) Render it:

```tsx
import type { FaceUiDoc } from '@userface/engine/face-ui';
import { FaceUi, createFaceUiRegistry } from '@userface/engine/face-ui';
```

Then pass `registry` (or `components`) that maps `node.type` → your React component.

