-- EspoCRM 9.3 演示数据：3 个销售身份 / 5 客户 / 5 联系人 / 5 商机，
-- 数值与 packages/adapter-espocrm/src/fixtures.ts 逐字对齐。
-- 前提：镜像自动安装已完成（首次 docker compose up 即建全 138 张表）。
-- 用法：docker exec -i espocrm-mysql-1 mysql --default-character-set=utf8mb4 \
--         -uroot -pespocrm_root espocrm < seed-demo-data.sql
--   ⚠️ 必须带 --default-character-set=utf8mb4：容器内 mysql 客户端默认 latin1，
--   中文会被双重编码存坏——orangehrm 真库评测的实测教训，此处照防。
--   重复执行前先清空相关行，见文末注释。
--
-- 设计说明（对应 docs/espocrm-db-schema.md 的实测结论）：
-- * id 列是 varchar(17) 且无外键约束——直插可读演示 id（e005/a001/o001…），
--   行级规则的契约「owner_id 的值 == 身份 userId」由本脚本负责成立。
-- * 姓名整名存 last_name、first_name 留空：中文名没有西式拆分且姓在前，
--   适配器按 CONCAT(last_name, first_name) 拼接（与 orangehrm 同款约定）。
-- * 联系人职务存 account_contact.role——contact 主表没有 title 列（9.3.10 实测）。
-- * 电话/邮箱不在主表：phone_number / email_address 独立表 + entity_* 关联表，
--   适配器只取 primary = 1 且 deleted = 0 的一条。
-- * stage 取 EspoCRM 缺省枚举（Prospecting…Closed Lost），与 fixture 逐字一致。

-- ── 销售身份（user；type regular，非管理员）──────────────
INSERT INTO `user` (id, user_name, first_name, last_name, `type`, is_active, deleted) VALUES
  ('e005', 'wangwu', '', '王五', 'regular', 1, 0),
  ('e007', 'sunqi',  '', '孙七', 'regular', 1, 0),
  ('e008', 'zhouba', '', '周八', 'regular', 1, 0);

-- ── 客户（account）────────────────────────────────────────
INSERT INTO account (id, name, industry, website, billing_address_city, assigned_user_id, created_at, deleted) VALUES
  ('a001', '华胜精密制造', '制造业', 'www.huasheng.example.com', '苏州', 'e007', NOW(), 0),
  ('a002', '蓝川物流',     '物流',   'www.lanchuan.example.com', '上海', 'e007', NOW(), 0),
  ('a003', '启明软件',     '软件',   'www.qiming.example.com',   '杭州', 'e008', NOW(), 0),
  ('a004', '恒达商贸',     '零售',   'www.hengda.example.com',   '深圳', 'e008', NOW(), 0),
  ('a005', '天工能源',     '能源',   'www.tiangong.example.com', '北京', 'e007', NOW(), 0);

-- ── 联系人（contact + account_contact.role 存职务）────────
INSERT INTO contact (id, first_name, last_name, account_id, assigned_user_id, created_at, deleted) VALUES
  ('c001', '', '陈建国', 'a001', 'e007', NOW(), 0),
  ('c002', '', '刘敏',   'a002', 'e007', NOW(), 0),
  ('c003', '', '周涛',   'a003', 'e008', NOW(), 0),
  ('c004', '', '吴芳',   'a004', 'e008', NOW(), 0),
  ('c005', '', '郑海',   'a005', 'e007', NOW(), 0);

INSERT INTO account_contact (account_id, contact_id, `role`, is_inactive, deleted) VALUES
  ('a001', 'c001', '采购总监',   0, 0),
  ('a002', 'c002', '运营经理',   0, 0),
  ('a003', 'c003', '技术总监',   0, 0),
  ('a004', 'c004', '采购经理',   0, 0),
  ('a005', 'c005', '设备部主任', 0, 0);

-- ── 邮箱（email_address + 关联；仅联系人）──────────────────
INSERT INTO email_address (id, name, lower, invalid, opt_out, deleted) VALUES
  ('m001', 'chenjianguo@huasheng.example.com', 'chenjianguo@huasheng.example.com', 0, 0, 0),
  ('m002', 'liumin@lanchuan.example.com',      'liumin@lanchuan.example.com',      0, 0, 0),
  ('m003', 'zhoutao@qiming.example.com',       'zhoutao@qiming.example.com',       0, 0, 0),
  ('m004', 'wufang@hengda.example.com',        'wufang@hengda.example.com',        0, 0, 0),
  ('m005', 'zhenghai@tiangong.example.com',    'zhenghai@tiangong.example.com',    0, 0, 0);

INSERT INTO entity_email_address (entity_id, email_address_id, entity_type, `primary`, deleted) VALUES
  ('c001', 'm001', 'Contact', 1, 0),
  ('c002', 'm002', 'Contact', 1, 0),
  ('c003', 'm003', 'Contact', 1, 0),
  ('c004', 'm004', 'Contact', 1, 0),
  ('c005', 'm005', 'Contact', 1, 0);

-- ── 电话（phone_number + 关联；客户座机 + 联系人手机）──────
INSERT INTO phone_number (id, name, `numeric`, `type`, deleted) VALUES
  ('p001', '0512-88001001', '051288001001', 'Office', 0),
  ('p002', '021-88002002',  '02188002002',  'Office', 0),
  ('p003', '0571-88003003', '057188003003', 'Office', 0),
  ('p004', '0755-88004004', '075588004004', 'Office', 0),
  ('p005', '010-88005005',  '01088005005',  'Office', 0),
  ('p101', '13900001001', '13900001001', 'Mobile', 0),
  ('p102', '13900001002', '13900001002', 'Mobile', 0),
  ('p103', '13900001003', '13900001003', 'Mobile', 0),
  ('p104', '13900001004', '13900001004', 'Mobile', 0),
  ('p105', '13900001005', '13900001005', 'Mobile', 0);

INSERT INTO entity_phone_number (entity_id, phone_number_id, entity_type, `primary`, deleted) VALUES
  ('a001', 'p001', 'Account', 1, 0),
  ('a002', 'p002', 'Account', 1, 0),
  ('a003', 'p003', 'Account', 1, 0),
  ('a004', 'p004', 'Account', 1, 0),
  ('a005', 'p005', 'Account', 1, 0),
  ('c001', 'p101', 'Contact', 1, 0),
  ('c002', 'p102', 'Contact', 1, 0),
  ('c003', 'p103', 'Contact', 1, 0),
  ('c004', 'p104', 'Contact', 1, 0),
  ('c005', 'p105', 'Contact', 1, 0);

-- ── 商机（opportunity；amount double / probability int / close_date date）──
INSERT INTO opportunity
  (id, name, account_id, stage, amount, amount_currency, probability, close_date, assigned_user_id, created_at, deleted) VALUES
  ('o001', '华胜产线扩建设备采购',     'a001', 'Proposal',    480000, 'CNY', 60,  '2026-09-30', 'e007', NOW(), 0),
  ('o002', '蓝川仓储管理系统年度合约', 'a002', 'Negotiation', 265000, 'CNY', 75,  '2026-08-15', 'e007', NOW(), 0),
  ('o003', '启明平台私有化部署',       'a003', 'Closed Won',  150000, 'CNY', 100, '2026-06-30', 'e008', NOW(), 0),
  ('o004', '恒达门店POS升级',          'a004', 'Prospecting', 98000,  'CNY', 20,  '2026-10-31', 'e008', NOW(), 0),
  ('o005', '天工电站运维三年框架',     'a005', 'Proposal',    720000, 'CNY', 55,  '2026-11-30', 'e007', NOW(), 0);

-- 复位（重新灌数据前执行）：
-- DELETE FROM opportunity WHERE id LIKE 'o0%';
-- DELETE FROM entity_phone_number WHERE phone_number_id LIKE 'p%';
-- DELETE FROM phone_number WHERE id LIKE 'p%';
-- DELETE FROM entity_email_address WHERE email_address_id LIKE 'm0%';
-- DELETE FROM email_address WHERE id LIKE 'm0%';
-- DELETE FROM account_contact WHERE contact_id LIKE 'c0%';
-- DELETE FROM contact WHERE id LIKE 'c0%';
-- DELETE FROM account WHERE id LIKE 'a0%';
-- DELETE FROM `user` WHERE id IN ('e005', 'e007', 'e008');
