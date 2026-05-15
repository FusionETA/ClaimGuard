# AltomateHR — Admin Setup Guide

This guide walks you through setting up AltomateHR for the first time. Each step must be completed **in order** — some steps depend on the one before them being done first.

> **Before you begin:** Make sure you have your Xero login details ready. Projects, accounts, and expense categories are all pulled from Xero — so connecting Xero is the foundation everything else is built on.

---

## Setup Overview

```
Step 1  → Set Up Your Organisation
Step 2  → Connect to Xero
Step 3  → Sync Projects from Xero
Step 4  → Sync Chart of Accounts from Xero
Step 5  → Create Employee Policies
Step 6  → Add Project Managers
Step 7  → Assign Project Managers to Their Projects
Step 8  → Add Supervisors
Step 9  → Create Teams
Step 10 → Add Employees
```

---

## Step 1 — Set Up Your Organisation

Before anything else, confirm your organisation details are correct.

1. Go to **Settings** in the admin menu.
2. You'll land on the **Organisation** tab.
3. Fill in or confirm:
   - **Organisation name**
   - **Working hours** — the standard start and end times for your company (e.g. 8:00 AM – 5:00 PM). This is used for overtime calculations.
   - **Timezone** — make sure this matches your location.
   - **Default currency** — used for expense claims.
   - **Mileage rate** — the rate per km/mile for mileage claims.
4. Click **Save**.

---

## Step 2 — Connect to Xero

Xero is where AltomateHR pulls your projects and expense account categories from. **You must connect Xero before you can add projects, set up teams, or let employees submit claims.**

1. In **Settings**, click on the **Accounts** tab (or look for the Xero connection card).
2. Click **Connect to Xero**.
3. You'll be redirected to Xero to log in. Sign in with your Xero credentials.
4. Select the **Xero organisation (tenant)** that matches your company and click **Allow access**.
5. You'll be brought back to AltomateHR. You should see a green "Connected" status next to your Xero organisation name.

> **Something went wrong?** If the connection fails, check that your Xero user has at least **Adviser** or **Standard** access in the Xero organisation. Limited access may block the sync.

---

## Step 3 — Sync Projects from Xero

Projects in AltomateHR come directly from Xero Projects. Each project also carries a physical location — this is what the app uses for attendance geofencing (checking that employees are clocking in from the right site).

1. In **Settings**, click on the **Projects** tab.
2. Click **Sync from Xero**. AltomateHR will pull all active projects from your connected Xero account.
3. Once synced, you'll see a list of your projects. For each project, fill in the **location details**:
   - **Location name** — a readable name (e.g. "Klang Valley Site A")
   - **GPS coordinates** (latitude and longitude) — used for the geofence check when employees clock in/out
   - **Geofence radius** — how close an employee needs to be to the site to clock in without a remark (e.g. 200 metres)
4. Save each project once its location is filled in.

> **Leave the Project Manager field empty for now.** You haven't added any users yet, so there's nobody to assign. You'll come back to this in Step 7.

> **Why does location matter?** If an employee clocks in from outside the geofence, the system flags it and adds a remark — but still allows the clock-in. This gives supervisors visibility without blocking employees who are legitimately on site but the GPS drifted slightly.

---

## Step 4 — Sync Chart of Accounts from Xero

Expense categories — things like Meals, Transport, Accommodation — come from your Xero Chart of Accounts. Employees select one of these when submitting a claim.

1. In **Settings**, click on the **Accounts** tab.
2. Click **Sync accounts from Xero**. AltomateHR will import your active account codes.
3. Review the list. You can:
   - Set **spend limits** per account (e.g. max RM 200/month for Meals) — employees will see a warning when approaching the cap.
   - Mark certain accounts as **mileage accounts** so the mileage rate calculator is shown for those claim types.
4. Save your changes.

> **Don't see the right accounts?** Make sure the accounts are active in Xero and are set up as **Expense** type accounts. Then re-sync.

---

## Step 5 — Create Employee Policies

Employee Policies control the rules that apply to different groups of employees — for example, whether daily workers must take a selfie when clocking in, or whether geofencing is enforced.

**Do this before adding any users**, because you'll assign a policy to each person at the time you create their account. Creating policies first means you won't have to go back and update everyone individually later.

1. Go to **Settings → Policies**.
2. Click **New Policy**.
3. Configure the settings:
   - **Require selfie on clock-in** — recommended on for daily (hourly) workers at physical sites
   - **Enforce geofencing** — on by default; turn off only for employees with genuinely flexible work locations
4. Give the policy a descriptive name (e.g. "Site Workers — Daily", "Office Staff — Monthly") and save it.

Repeat to create as many policies as your different groups of staff need. Most organisations only need two or three.

---

## Step 6 — Add Project Managers

> **What is a Project Manager in AltomateHR?**
> A Project Manager is not a separate login role — they are a **Supervisor-role user** who is additionally designated as the manager of one or more projects. This gives them the highest level in the approval chain for their project (e.g. they approve OT after the supervisor approves it first). Project Managers' own attendance is auto-approved — they don't need anyone to sign off on their clock-ins.

Add Project Managers before supervisors and teams, because teams reference them in their approval chain structure.

1. Go to **Hierarchy** in the admin menu.
2. Click **Add Member**.
3. Fill in:
   - **Full name** and **email address**
   - **Employee ID**
   - **Role** — select **Supervisor** (Project Managers use the Supervisor role)
   - **Job title** — e.g. "Project Manager"
   - **Worker type** — Monthly
   - **Temporary password**
   - **Project(s)** — assign the projects this person manages
   - **Employee Policy** — assign the relevant employee policy from Step 5
4. Click **Save**.

Repeat for each Project Manager.

---

## Step 7 — Assign Project Managers to Their Projects

Now that your Project Managers exist as users, go back to the Projects tab and link them.

1. Go to **Settings → Projects**.
2. Click on a project to edit it.
3. In the **Project Manager** field, select the user(s) you added in Step 6.
4. Save the project.

Repeat for each project that has a dedicated manager.

> **Why does this matter?** Assigning a user as a Project Manager is what tells the system to route certain approvals (like OT for their team) up to them. Without this link, the approval chain is incomplete.

---

## Step 8 — Add Supervisors

Supervisors handle day-to-day attendance and claims approvals for their team. **Add supervisors before creating teams**, as teams require you to assign supervisors to specific approval layers.

1. Go to **Hierarchy** in the admin menu.
2. Click **Add Member**.
3. Fill in:
   - **Full name** and **email address**
   - **Employee ID**
   - **Role** — select **Supervisor**
   - **Job title**
   - **Worker type** — Monthly (supervisors are always monthly)
   - **Temporary password**
   - **Project(s)** — assign the projects this supervisor works under
   - **Employee Policy** — assign the relevant employee policy from Step 5
4. Click **Save**.

Repeat for each supervisor. They can log in right away using their temporary password.

---

## Step 9 — Create Teams

Teams sit inside a project and define the approval structure — who approves what, and how many layers of approval are required. **Project Managers (Step 6–7) and Supervisors (Step 8) must exist before you create teams**, because you'll assign them to specific approval layers when setting up each team.

Each team has:
- A **project** it belongs to
- A **name** (e.g. "Site A — Labour Team")
- One or more **approval layers** (e.g. Layer 1 = Supervisor, Layer 2 = Project Manager)

**To create a team:**

1. Go to **Company Structure** in the admin menu.
2. Click **New Team**.
3. Select the **project** this team works under.
4. Give the team a **name**.
5. Set the number of **approval layers** and label each one clearly (e.g. Layer 1: Supervisor, Layer 2: Project Manager).
6. Configure which modules each layer approves — for example, you might want both layers to approve OT, but only Layer 1 for regular attendance.
7. Click **Save**.

Repeat for each team across your projects.

---

## Step 10 — Add Employees

Now that everything is in place — projects, policies, project managers, supervisors, and teams — you can add employees. **All of the above must exist first**, otherwise you won't be able to fully assign the employee's account.

1. Go to **Hierarchy** in the admin menu.
2. Click **Add Member**.
3. Fill in:
   - **Full name** and **email address**
   - **Employee ID**
   - **Role** — select **Employee**
   - **Job title**
   - **Worker type**:
     - **Daily (Hourly)** — paid based on hours worked; typically requires selfie on clock-in
     - **Monthly** — salaried staff
   - **Hourly rate** — required for daily workers
   - **OT payout method** — Cash or Time Bank (for monthly workers)
   - **Temporary password**
   - **Project(s)** — assign the employee to their worksite(s)
   - **Team** — the team within that project
   - **Approval layer** — which layer this employee sits at (typically the base layer)
   - **Employee Policy** — assign the employee policy you created in Step 5
4. Click **Save**.

Repeat for each employee. Each one can log in immediately using their temporary password.

---

## You're Ready

Once all steps are done, your organisation is fully set up. Here's a quick checklist:

- [ ] Organisation details saved (working hours, timezone, currency, mileage rate)
- [ ] Xero connected and showing "Connected"
- [ ] Projects synced, location and geofence details filled in for each
- [ ] Chart of Accounts synced; spend limits configured where needed
- [ ] Employee policies created for each group of staff
- [ ] Project Managers added as Supervisor-role users
- [ ] Project Managers assigned to their projects in Settings → Projects
- [ ] Supervisors added and assigned to their projects
- [ ] Teams created with correct approval layers for each project
- [ ] Employees added with projects, teams, approval layers, and employee policies assigned

---

## What Happens Next

Once employees log in, they can immediately:
- Clock in and out from their dashboard
- Submit expense claims

As clock-in/out requests and claims come in, supervisors will see them in their approvals queue. OT requests follow the full approval chain (Supervisor → Project Manager). You can monitor everything from the **Admin Dashboard** and the **Claims** section in the admin menu.

---

## Need Help?

If you get stuck at any step — particularly around Xero connectivity or project sync — contact your AltomateHR support contact. Make sure to mention which step you're on and any error messages you see on screen.
