# OrangeHRM 5.7 真实 DB Schema（只读 MySQL 适配器依据）

来源：容器内 `installer/Migration/V3_3_3/dbscript-1.sql` 建表 DDL（2026-07-16 实测，orangehrm/orangehrm:5.7 镜像）。REST 模式因 client_credentials 不被支持而改走只读直连 MySQL（见 [orangehrm-api-notes.md](./orangehrm-api-notes.md)），本文件是那个适配器要 join 的表结构。仅列适配器用得到的列。

## 主键与外键关系

```
hs_hr_employee.emp_number (PK, int)          ← 内部主键，join 用
hs_hr_employee.employee_id (varchar50)       ← 人工填的工号（演示录 e001~e006），对外 employee_id
hs_hr_employee.job_title_code   → ohrm_job_title.id
hs_hr_employee.work_station     → ohrm_subunit.id      （dept = subunit.name）
hs_hr_emp_basicsalary.emp_number → hs_hr_employee.emp_number
ohrm_leave_entitlement.emp_number → hs_hr_employee.emp_number
ohrm_leave_entitlement.leave_type_id → ohrm_leave_type.id
```

## 统一行结构 ← 表列映射

| 统一字段 | 来源列 | 备注 |
| --- | --- | --- |
| `employee_id` | `hs_hr_employee.employee_id` | 工号，非 emp_number |
| `name` | `emp_lastname` + `emp_firstname` + `emp_middle_name` | 中文姓名拼接顺序需按演示数据核（姓在前） |
| `dept` | `ohrm_subunit.name` via `work_station` | |
| `title` | `ohrm_job_title.job_title` via `job_title_code` | 注意列名是 `job_title` 不是 `title` |
| `email` | `emp_work_email` → `emp_oth_email` | |
| `phone` | `emp_work_telephone` → `emp_mobile` → `emp_hm_telephone` | |
| `salary` | `hs_hr_emp_basicsalary.ebsal_basic_salary` | **varchar**，需转数值；多条取一条 |
| `currency` | `hs_hr_emp_basicsalary.currency_id` | varchar6，如 "CNY" |
| `annual_total` | `ohrm_leave_entitlement.no_of_days` | decimal，按 leave_type=年假 筛 |
| `annual_used` | `ohrm_leave_entitlement.days_used` | decimal，列名是 `days_used`（非 usedDays） |
| `annual_left` | total − used 适配器算 | |

离职过滤：`hs_hr_employee.termination_id IS NULL`（在职）。软删：job_title 有 `is_deleted`、leave_type 有 `deleted`、leave_entitlement 有 `deleted`，查询都要带 `= 0`。

## 关键 DDL 摘录

```sql
create table `hs_hr_employee` (
  `emp_number` int(7) not null default 0,       -- PK
  `employee_id` varchar(50) default null,        -- 对外工号
  `emp_lastname`  varchar(100) not null default '',
  `emp_firstname` varchar(100) not null default '',
  `emp_middle_name` varchar(100) not null default '',
  `emp_work_email` varchar(50), `emp_oth_email` varchar(50),
  `emp_work_telephone` varchar(50), `emp_mobile` varchar(50), `emp_hm_telephone` varchar(50),
  `job_title_code` int(7),      -- → ohrm_job_title.id
  `work_station` int(6),        -- → ohrm_subunit.id
  `termination_id` int(4),      -- NULL = 在职
  primary key (`emp_number`)
);
create table `ohrm_job_title` (`id` int PK auto_increment, `job_title` varchar(100), `is_deleted` tinyint default 0);
create table `ohrm_subunit`   (`id` int PK auto_increment, `name` varchar(100) unique, ...);
create table `hs_hr_emp_basicsalary` (
  `id` int PK auto_increment, `emp_number` int(7),
  `currency_id` varchar(6), `ebsal_basic_salary` varchar(100)  -- 金额是字符串
);
create table `ohrm_leave_type` (`id` int PK, `name` varchar(50), `deleted` tinyint default 0);
create table `ohrm_leave_entitlement` (
  `id` int PK, `emp_number` int(7), `no_of_days` decimal(19,15),
  `days_used` decimal(8,4) default 0, `leave_type_id` int, `deleted` tinyint default 0
);
```

## 适配器实现要点

- 连接用**只读账号**（演示可先用 root，生产建 `GRANT SELECT`）+ ai-edge NL2SQL 四层守卫：词法掩码黑名单 / 强制 LIMIT / `stmt.readonly` 断言 / 连接级 readonly。
- 一条 join 查询覆盖 list/get_employee/get_salary/get_leave；salary 与 leave 是一对多，用子查询或应用层取一条，避免行乘积。
- 演示数据要在装完后按 fixture 口径录 6 人（工号 e001~e006、部门/职位/薪资对齐 [fixtures.ts](../packages/adapter-orangehrm/src/fixtures.ts)），使 fixture 模式与 MySQL 模式返回同构。
