# Userface Readiness (userface-readiness@1)

Status: ready
Score: 98
Repo: <fixture>/billing-dashboard
Framework: react (next@15.0.0)
TypeScript: yes
Proof: ufp_b97f3a06e0351dae593a (passed)

## Components

Discovered: 6
Contracts: 6/6
Contract coverage: 100%
Props: 15
States: 6
First screen: screens/fixed.ui.json (passed)
Pilot verdict: ready (can run first-screen pilot)
Composition: 1 checked, 0 violation(s)

## Pilot Feasibility

Ready for a first-screen AI UI acceptance pilot.

Blockers:
- none

Required fixes:
- none

## Safe Components

- BillingDashboard (src/components/BillingDashboard) - React component with face.json contract and no registry diagnostics.
- BillingTable (src/components/BillingTable) - React component with face.json contract and no registry diagnostics.
- InternalDebugPanel (src/components/InternalDebugPanel) - React component with face.json contract and no registry diagnostics.
- KpiCard (src/components/KpiCard) - React component with face.json contract and no registry diagnostics.
- PlanBanner (src/components/PlanBanner) - React component with face.json contract and no registry diagnostics.
- UsageMeter (src/components/UsageMeter) - React component with face.json contract and no registry diagnostics.

## Unsafe Components

- none

## Token/Style Risks

Status: passed
- none

## Render/Preview Readiness

Status: passed
Preview evidence can be attached after guard passes and desktop/CI render validation runs.

Required evidence:
- guard proof
- desktop render validation
- preview/screenshot artifact

## Checks

- passed: Framework - next@15.0.0 detected.
- passed: TypeScript - TypeScript signal detected.
- passed: Components - 6 component(s) discovered in src/components.
- passed: Component contracts - 6/6 components have face.json contracts.
- passed: Registry diagnostics - Component registry scan produced no diagnostics.
- passed: Token/style risks - Token/style signal is present or not blocking for this readiness pass.
- passed: ui@1 documents - 1 ui@1 document(s) discovered.
- passed: Composition gate - 1 ui@1 document(s) passed composition readiness.
- passed: First-screen feasibility - First-screen candidate: screens/fixed.ui.json.
- passed: Preview readiness - Preview evidence can be attached after guard passes and desktop/CI render validation runs.
- passed: Offline guard - Offline guard can run locally with zero model/network egress.

## Recommendation

Repo is ready for an AI UI acceptance pilot.

- Run userface guard on a representative ui@1 change and attach the generated proof to the PR.
