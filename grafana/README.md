# Grafana

Grafana Cloud's free tier, pointed at the `reporting` schema in Supabase through a read-only
database role. Nothing in Grafana can reach `public` or `vault`.

## One-time setup

1. **Give the reader role a password.** In the Supabase dashboard, SQL Editor, run this with a
   long random password of your own (letters and digits are simplest):

   ```sql
   alter role grafana_reader with login password 'YOUR-PASSWORD-HERE';
   ```

2. **Create a Grafana Cloud account** at grafana.com (free tier). Open your stack.

3. **Add the datasource.** Connections, then Data sources, then Add new, then PostgreSQL:

   | Field | Value |
   |---|---|
   | Host | the Session pooler host from Supabase's Connect dialog, e.g. `aws-0-ap-northeast-1.pooler.supabase.com:5432` |
   | Database | `postgres` |
   | User | `grafana_reader.<project-ref>` (the pooler needs the project ref suffix) |
   | Password | the one you set in step 1 |
   | TLS/SSL mode | `require` |
   | Version | 17 |

   Save and test. It should report the connection is OK.

4. **Import the dashboard.** Dashboards, then New, then Import, then upload
   `dashboards/splitset.json`. Pick the datasource when prompted.

## Views

| View | One row per | Use |
|---|---|---|
| `reporting.users` | user | the `user` dashboard variable |
| `reporting.activities` | activity | tables, scatter plots, anything per session |
| `reporting.weekly_volume` | user, week, type | weekly km / hours / load bars |
| `reporting.daily_load` | user, day (zero-filled) | load, 7-day and 28-day means, ACWR |
| `reporting.wellness_daily` | user, day | RHR, HRV, sleep, weight, CTL/ATL with rolling means |
| `reporting.best_efforts` | activity, distance | fastest 1 km to marathon inside each run |
| `reporting.records` | user, distance | all-time fastest per distance |
| `reporting.hr_zone_monthly` | user, month, zone | intensity distribution |

Every view has a `user_id`; add `where user_id = '${user}'` to each panel query.
