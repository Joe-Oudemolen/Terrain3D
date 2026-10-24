import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/**/*.gpu.test.ts'],
        },
      },
      {
        test: {
          name: 'gpu',
          include: ['tests/**/*.gpu.test.ts'],
          browser: {
            enabled: true,
            provider: playwright({
              launchOptions: { channel: 'chrome', args: ['--enable-unsafe-webgpu'] },
            }),
            headless: false,
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
