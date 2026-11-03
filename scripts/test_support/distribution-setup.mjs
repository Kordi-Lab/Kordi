import { fileURLToPath } from 'node:url';
// Synthetic test configuration; all publisher network/storage dependencies are mocked by tests.
process.env.KORDI_DISTRIBUTION_PROFILE = fileURLToPath(new URL('./distribution/app.json', import.meta.url));
process.env.KORDI_EXPECTED_EDITION = 'app';
process.env.KORDI_EXPECTED_ENVIRONMENT = 'production';
process.env.KORDI_EXPECTED_BACKEND_ORIGIN = 'https://kordi.ai';
