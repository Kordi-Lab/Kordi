import path from 'node:path'
import { distributionFiles, stageDistribution, verifyDistribution } from '../../../scripts/licenses.mjs'

/**
 * Stages the Help menu licenses page into a development public directory.
 * Release builds stage it in their build scripts; without this, the dev server
 * answers the iframe with the app's own index page.
 */
export function ensureDevLicenses(output, { directory, log = console } = {}) {
  try {
    const files = distributionFiles(directory)
    try {
      verifyDistribution(output, files)
      return 'current'
    } catch {
      stageDistribution(output, directory)
      return 'staged'
    }
  } catch (error) {
    log.warn(`[kordi] Open-source licenses page not staged: ${error instanceof Error ? error.message : String(error)}`)
    return 'unavailable'
  }
}

export function devLicensesPlugin(options = {}) {
  return {
    name: 'kordi-dev-licenses',
    apply: 'serve',
    configResolved(config) {
      if (config.publicDir) ensureDevLicenses(path.join(config.publicDir, 'licenses'), options)
    },
  }
}
