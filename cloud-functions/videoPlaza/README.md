# CloudBase videoPlaza

This directory owns the CloudBase `videoPlaza` function for the video plaza.

## Environment

Required for admin APIs:

- `PLAZA_ADMIN_KEY`

Required for VOD upload/query:

- `VOD_SECRET_ID`
- `VOD_SECRET_KEY`
- `VOD_REGION` (defaults to `ap-guangzhou`)

Required for billing dashboard:

- `TENCENT_SECRET_ID`
- `TENCENT_SECRET_KEY`

If `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` are omitted, the function falls back to `VOD_SECRET_ID` / `VOD_SECRET_KEY`.

Required for coach source resolver:

- `TIKHUB_TOKEN`
- `TIKHUB_BASE` (defaults to `https://api.tikhub.io`)

Optional mail notification variables:

- `MAIL_USER`
- `MAIL_PASS`

## Admin Actions Added In Phase 1

- `getBillingDashboard`: returns account balance, month cost, VOD cost, storage usage, CDN usage, update time, and warnings.
- `resolveCoachSource`: resolves a Douyin source link/share text into a coach draft. It fills the admin form only; it does not create the coach automatically.
