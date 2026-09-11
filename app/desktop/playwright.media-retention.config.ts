import { defineConfig } from '@playwright/test';
import history from './playwright.history.config';
export default defineConfig({ ...history, testMatch: 'mediaRetention.spec.ts' });
