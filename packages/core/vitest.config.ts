import { defineConfig } from 'vitest/config';

// core 是安全内核（守卫/审批/审计链/rbac）——这里的一处未测分支最危险。
// 覆盖率底线设在当前水位（stmt/line 93.5%、branch 88%、fn 96%）之下留一点缓冲，
// 锁住覆盖不退化，又不因个位数波动误伤。仅 `--coverage`（CI）时生效，本地 `vitest run` 不受影响。
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/types.ts'],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});
