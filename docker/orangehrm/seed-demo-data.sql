-- OrangeHRM 5.7 演示数据：6 名员工，数值与 packages/adapter-orangehrm/src/fixtures.ts 逐字对齐。
-- 前提：CLI/向导安装已完成（installer 会创建 emp_number=1 的管理员员工）。
-- 用法：mysql --default-character-set=utf8mb4 -uroot -p<pw> orangehrm < seed-demo-data.sql
--   ⚠️ 必须带 --default-character-set=utf8mb4：容器内 mysql 客户端默认 latin1，
--   中文会被双重编码存坏（读出来是 çŽ‹äº” 这类乱码）——2026-07-16 真库评测抓到过。
--   重复执行前先清空相关表，见文末注释。
--
-- 设计说明：
-- * 安装器创建的管理员员工不删除、不离职（离职可能影响登录），而是直接改造成
--   演示花名册里的老李 e004（HR主管）——"hr_admin 演示身份 = 系统管理员"叙事自洽，
--   且全员恰好 6 人，与 fixture 契约一致。
-- * 姓名整名存 emp_firstname、emp_lastname 留空：中文名没有西式 first/last 拆分，
--   这样 UI 与适配器拼接（lastname+firstname+middle）都显示「张三」。
-- * ohrm_subunit 是嵌套集合树：root(1,2) 扩为 (1,12)，5 个部门挂 level 1。
-- * hs_hr_emp_basicsalary 无生效日期列（REST/MySQL 后端 effective_date 返回空串）。

-- ── 部门（嵌套集合） ─────────────────────────────────────
UPDATE ohrm_subunit SET rgt = 12 WHERE id = 1 AND rgt = 2;
INSERT INTO ohrm_subunit (name, lft, rgt, level) VALUES
  ('生产部',   2,  3, 1),
  ('行政部',   4,  5, 1),
  ('人事部',   6,  7, 1),
  ('商务部',   8,  9, 1),
  ('研发中心', 10, 11, 1);

-- ── 职位 ────────────────────────────────────────────────
INSERT INTO ohrm_job_title (job_title, is_deleted) VALUES
  ('设备工程师', 0), ('行政专员', 0), ('班组长', 0),
  ('HR主管', 0), ('商务经理', 0), ('前端工程师', 0);

-- ── 管理员员工改造成老李 e004 ────────────────────────────
UPDATE hs_hr_employee SET
  employee_id = 'e004',
  emp_firstname = '老李', emp_lastname = '', emp_middle_name = '',
  emp_work_email = 'laoli@example.com',
  emp_work_telephone = '13800000004',
  job_title_code = (SELECT id FROM ohrm_job_title WHERE job_title = 'HR主管'),
  work_station   = (SELECT id FROM ohrm_subunit  WHERE name = '人事部')
WHERE emp_number = 1;

-- ── 其余 5 人（emp_number 无自增，显式编号） ──────────────
INSERT INTO hs_hr_employee
  (emp_number, employee_id, emp_firstname, emp_lastname, emp_middle_name,
   emp_work_email, emp_work_telephone, job_title_code, work_station) VALUES
  (2, 'e001', '张三', '', '', 'zhangsan@example.com', '13800000001',
    (SELECT id FROM ohrm_job_title WHERE job_title = '设备工程师'),
    (SELECT id FROM ohrm_subunit WHERE name = '生产部')),
  (3, 'e002', '小王', '', '', 'xiaowang@example.com', '13800000002',
    (SELECT id FROM ohrm_job_title WHERE job_title = '行政专员'),
    (SELECT id FROM ohrm_subunit WHERE name = '行政部')),
  (4, 'e003', '李四', '', '', 'lisi@example.com', '13800000003',
    (SELECT id FROM ohrm_job_title WHERE job_title = '班组长'),
    (SELECT id FROM ohrm_subunit WHERE name = '生产部')),
  (5, 'e005', '何静', '', '', 'hejing@example.com', '13800000005',
    (SELECT id FROM ohrm_job_title WHERE job_title = '商务经理'),
    (SELECT id FROM ohrm_subunit WHERE name = '商务部')),
  (6, 'e006', '赵六', '', '', 'zhaoliu@example.com', '13800000006',
    (SELECT id FROM ohrm_job_title WHERE job_title = '前端工程师'),
    (SELECT id FROM ohrm_subunit WHERE name = '研发中心'));

-- ── 薪资（金额列是 varchar，按源系统原样存字符串） ─────────
INSERT INTO hs_hr_emp_basicsalary (emp_number, currency_id, ebsal_basic_salary) VALUES
  (2, 'CNY', '18500'),
  (3, 'CNY', '9800'),
  (4, 'CNY', '15200'),
  (1, 'CNY', '22000'),
  (5, 'CNY', '16800'),
  (6, 'CNY', '21000');

-- ── 年假（leave_type + entitlement；entitlement_type 1 = Added） ──
INSERT INTO ohrm_leave_type (name, deleted, exclude_in_reports_if_no_entitlement)
  VALUES ('年假', 0, 0);

INSERT INTO ohrm_leave_entitlement
  (emp_number, no_of_days, days_used, leave_type_id,
   from_date, to_date, credited_date, entitlement_type, deleted)
SELECT t.emp_number, 10, t.used, lt.id,
       '2026-01-01 00:00:00', '2026-12-31 23:59:59', NOW(), 1, 0
FROM (SELECT 2 AS emp_number, 6.0 AS used UNION ALL
      SELECT 3, 3.0 UNION ALL
      SELECT 4, 5.0 UNION ALL
      SELECT 1, 2.0 UNION ALL
      SELECT 5, 4.0 UNION ALL
      SELECT 6, 1.0) t
JOIN ohrm_leave_type lt ON lt.name = '年假';

-- 复位（重新灌数据前执行）：
-- DELETE FROM ohrm_leave_entitlement; DELETE FROM ohrm_leave_type;
-- DELETE FROM hs_hr_emp_basicsalary;
-- DELETE FROM hs_hr_employee WHERE emp_number > 1;
-- DELETE FROM ohrm_job_title; DELETE FROM ohrm_subunit WHERE id > 1;
-- UPDATE ohrm_subunit SET rgt = 2 WHERE id = 1;
