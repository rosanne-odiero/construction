# Phase 8 demo: health and safety (D8.2)

This walkthrough is **not** Phase 8 acceptance. It covers the health and safety module (D8.2):
site inductions with flags from attendance, toolbox talks, the PPE register, incidents and near
misses, corrective actions and first aid, and the done-when flow: incident → investigation →
corrective actions → done → verified → incident closed and locked. Dashboards and reports (D8.1),
plant (D8.3), documents and the compliance register (D8.4) and offline/site-app capture remain
pending. Notifying the regulator (DOSH) and the OSHA/WIBA registers are **COMPLIANCE-REVIEW**
items (CR-HS-01 to CR-HS-04): the system records what you did; it files nothing.

## Start

Use the existing local services and API/web servers, or the root README quick start. Apply the
forward migration and seed the synthetic company:

```bash
pnpm --filter @pm-buddy/api db:generate
pnpm db:migrate
pnpm db:seed
```

The seed prints the synthetic accounts and their generated passwords. You need two identities in
separate browser profiles: the **site agent** (Kevin Kiprono) and the **project manager** (Brian
Otieno). Both hold `safety.manage` on Ruiru Heights; the walkthrough uses that to show the
maker-checker rule: the owner of a corrective action marks it done, and **someone else** verifies
it. A foreman (`site.diary`) can record but not investigate, verify or close.

## Review

1. As the site agent, open **Health and safety** in the sidebar (`/safety`). The overview lists
   Ruiru Heights with its open incidents, overdue actions, flagged labourers, PPE due and kits
   needing attention. Open the project's **Health and safety** tab.
2. **Incidents.** INC-0001 (near miss, closed and locked) and INC-0002 (injury, investigated, one
   overdue action) are listed with counts and filters.
3. **Report an incident on a phone** (narrow the window to 360 px): *Report an incident*, choose
   *Injury*, severity *Serious*, the location and a description (no names or medical details there).
   Under *People*, add the injured labourer (search by name or worker number), the injury and the
   part of the body, and a witness by name only. Report it. Note that *Before closing* lists the
   investigation and the regulator decision.
4. As the project manager, open the new incident: **Record investigation** (root-cause category and
   root cause), then **Raise a corrective action** owned by the site agent with a due date, then
   **Record the decision** (*Notified* with today's date, or *Not notifiable* with a reason). The
   manager cannot mark the agent's action done, and *Close incident* is not offered yet.
5. As the site agent, **Mark done** on the action with a note. The owner is not offered *Verify*.
6. As the project manager, **Verify** the action, then **Close incident**. The page shows "Closed and
   locked": no edit, void, investigation, action or photo controls remain; *Report a follow-up* is
   offered instead. The database refuses changes to a closed incident for every role.
7. **Corrective actions**: overdue actions come first (CA-0003 on INC-0002, owned by the site
   agent). Filter by *Overdue* or *Only mine*; *Send back* needs a reason.
8. **Inductions**: choose the Main plot. Two labourers are flagged "Worked here without a valid
   induction on …" (read from attendance; the muster was never blocked). Record an induction for one
   of them (topics from the company checklist, acknowledgement). The flag for the days already
   worked stays until it leaves the 14-day look-back.
9. **Toolbox talks**: *Record a toolbox talk* on a phone with a gang and an extra labourer, *Save
   draft*, then *Save and confirm*: once confirmed the talk and its attendance are locked.
10. **PPE register**: items due for replacement are flagged; *Replace* records the new issue,
    *Return* records the condition. The register does not move stock in the stores (decision D-72).
11. **First aid**: the scaffold kit's check is overdue; *Record a check* with the earliest expiry
    date. First-aiders show their certificate expiry; the treatment FA-0001 is linked to INC-0002.
    Sign in as a foreman (if you add one) to see that who was treated and injuries are restricted to
    safety managers.
12. As the owner, **Safety settings** (`/safety/settings`): the induction checklist, induction
    validity, the attendance look-back, the kit check interval and PPE replacement periods.
13. Switch to **SW** and the dark theme at 360 px: every view stays readable without sideways
    scrolling.

## What to look for

- Clients, suppliers, labourers and office roles (QS, finance) cannot open any safety record.
- Names of injured people and witnesses and injury codes appear only for safety managers; the audit
  log never contains them.
- Overdue actions are listed first everywhere and counted on the tab.
- The COMPLIANCE-REVIEW note on every view: thresholds and deadlines for notifying DOSH and the
  WIBA Director, the statutory registers, PPE and first-aid minimums await an adviser.
