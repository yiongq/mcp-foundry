export type { EspoCrmAdapterOptions } from './adapter.js';
export { createEspoCrmAdapter, mysqlConfigFromEnv } from './adapter.js';
export type {
  AccountDetail,
  AccountRow,
  ContactRow,
  EspoCrmBackend,
  OpportunityRow,
  PipelineSummaryRow,
} from './backend.js';
export {
  FIXTURE_ACCOUNTS,
  FIXTURE_CONTACTS,
  FIXTURE_OPPORTUNITIES,
  FIXTURE_OWNERS,
  FixtureBackend,
} from './fixtures.js';
export type { MySqlBackendOptions, SqlExecutor } from './mysql.js';
export { MySqlEspoCrmBackend } from './mysql.js';
