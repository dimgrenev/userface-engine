export interface UsageMeterProps {
  label: string;
  value: number;
  max: number;
  state: 'normal' | 'near_limit' | 'over_limit';
}

export function UsageMeter(_props: UsageMeterProps) {
  return null;
}
