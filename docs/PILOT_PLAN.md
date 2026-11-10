# PM-Buddy: Proposed pilot

**Design and proposed delivery order approved by the owner in this session.** The owner selected "Approve the pilot design and proposed delivery order only". This does not authorise later-phase implementation, deployment, real payouts, biometric collection or a live pilot start.

## Proposed bounded scope

- One contractor and one site; named owner, site supervisor, Finance reviewer and independent approver.
- Manual/QR attendance with supervisor confirmation and non-biometric fallback.
- Reviewed payroll using approved effective-dated rules and independent maker-checker identities.
- One verified payout method, approved recipient verification and daily reconciliation.
- Restricted tenant/project access, redacted audit and safe operating view.

Keep biometrics, USSD, additional rails and advanced analytics on the existing later roadmap unless explicitly prioritised. This is a proposed pilot cut, not removal of any existing module.

## Approved pilot delivery-order design

Retain Phase 0–9 and all existing deliverables. Complete foundation first; then projects/basic BQ, non-biometric offline attendance, reviewed payroll, one payout method and reconciliation for the pilot cut. Defer other payment rails and biometric capture until their own gates pass. This approved pilot sequencing does not remove any module or approve implementation of later phases.

## Entry evidence

| Gate | Required evidence | Current status |
|---|---|---|
| Scope and sequencing | Explicit owner approval of this proposal | Design/delivery order approved in this session; live activation not approved |
| Tenant/provider onboarding | Correct production account, credentials, capabilities and recipient verification | Not verified |
| Payroll/QS policy | Named reviewers, sources/effective dates and independently approved golden calculations | Not reviewed |
| Security/privacy | Isolation and recovery tests, purpose/retention review, support boundaries | Incomplete |
| Offline field use | Real low-end Android test, revocation, late records, attachment recovery | Not executed |
| Recovery | Coherent DB/object/key restore and provider reconciliation rehearsal | Not executed |
| Operations | Named owners, alert recipients, payout pause, costs/quotas and escalation | Not assigned |
| Controlled settlement exercise | Small explicitly authorised transactions matched to provider evidence; independent sign-off | Not authorised/executed |

## Exit and stop conditions

Owner and Finance review reconciliation completeness, uncertainty age, payroll disputes, missing evidence, sync conflicts, accessibility/Kiswahili feedback and operating cost. Agree measurable targets before starting; do not invent a successful pilot from a green build.

Pause new payouts for uncertain duplicates, tenant-boundary failures, mismatched settlement, missing approval provenance or restore inconsistency. Preserve evidence and resolve under the operations runbook. No test notification/payment goes to a real person without separate explicit authorisation.
