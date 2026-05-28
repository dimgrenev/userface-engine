# Userface Proof ufp_38656d8bcf601c18e14d

Status: blocked
Target: pr_gate
Paths: screens/broken.ui.json
Validation: not_run - No component source targets checked
Composition: failed - Broken billing dashboard: 8 issue(s) found (score: 87/100)
Preview: not_run - CLI guard does not render preview artifacts in v0.
Egress: offline, zero_upload, model calls 0, files sent 0, bytes sent 0

- screens/broken.ui.json: Broken billing dashboard: 8 issue(s) found (score: 87/100)

## Violations
- [error] composition/invalid-enum-value (PlanBanner): Prop "plan" on "PlanBanner" has value "ultimate" which is not in allowed options: starter, growth, enterprise
  Fix: Use one of: starter, growth, enterprise
- [error] composition/invalid-enum-value (KpiCard): Prop "tone" on "KpiCard" has value "danger" which is not in allowed options: neutral, positive, warning
  Fix: Use one of: neutral, positive, warning
- [error] composition/invalid-enum-value (BillingTable): Prop "density" on "BillingTable" has value "giant" which is not in allowed options: compact, comfortable
  Fix: Use one of: compact, comfortable
- [error] composition/missing-required-prop (KpiCard): Required prop "value" missing on "KpiCard"
  Fix: Add prop "value" (type: string) to "KpiCard"
- [error] composition/missing-required-prop (UsageMeter): Required prop "max" missing on "UsageMeter"
  Fix: Add prop "max" (type: number) to "UsageMeter"
- [warning] composition/registry-boundary-non-public-component (InternalDebugPanel): Component type "InternalDebugPanel" has "private" registry visibility; only Face UI components and public UF registry components are allowed by the registry boundary
  Fix: Use a Face UI primitive, use a public UF registry component, or mark "InternalDebugPanel" public in the UF registry manifest.
- [info] composition/list-missing-keys (BillingDashboard): 5 children of "BillingDashboard" lack "key" prop — may cause rendering issues
  Fix: Add unique "key" to each child in lists for stable identity.
- [info] composition/unknown-prop (BillingTable): Unknown prop "sparkles" on "BillingTable"
  Fix: Check if "sparkles" is a valid prop for "BillingTable". Known props: rows, density, emptyState
