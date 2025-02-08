import * as core from '@actions/core'
import * as exec from '@actions/exec'
import {boolean} from 'boolean'
import * as semver from 'semver'
import {deviceToString, getDevices, install, plutil, simctl} from './xcrun'

async function run(): Promise<void> {
  try {
    const model = core.getInput('model')
    let os = core.getInput('os')
    const os_version = core.getInput('os_version')
    const udid = core.getInput('udid')
    const locale = core.getInput('locale')

    if (!udid && !os && !os_version && !model) {
      // Give a reasonable default, otherwise we may end up with tvOS, which is
      // unlikely to be a good guess.
      os = 'iOS'
    }

    const matchingDevices = (await getDevices()).filter(device => {
      core.debug(`- ${deviceToString(device)}`)

      if (udid && device.udid !== udid) {
        core.debug('UDID does not match the request')
        return false
      }
      if (model && device.model !== model) {
        core.debug('Model does not match the request')
        return false
      }
      if (os && device.os !== os) {
        core.debug('OS does not match the request')
        return false
      }
      if (os_version) {
        const device_os_version = semver.coerce(device.os_version)
        if (
          !device_os_version ||
          !semver.satisfies(device_os_version, os_version)
        ) {
          core.debug('OS version does not match the request')
          return false
        }
      }

      return true
    })

    if (!matchingDevices.length) {
      core.setFailed(
        'No devices found for the matching requirements. See ' +
          'https://github.com/futureware-tech/simulator-action/wiki for the ' +
          'list of available devices'
      )
      return
    }

    if (matchingDevices.length > 1) {
      core.warning(
        `More than one (${matchingDevices.length}) device matching ` +
          `requirements ` +
          `(os:[${os}] os_version:[${os_version}] model:[${model}]) ` +
          'have been found.'
      )
    }

    const device = matchingDevices[0]
    core.info(`Picked a device: ${deviceToString(device)}`)

    if (device.state !== 'Shutdown') {
      core.warning(
        `Device currently in state: ${device.state}, shutting down first...`
      )
      await simctl('shutdown', device.udid)
    }

    if (boolean(core.getInput('erase_before_boot'))) {
      core.info(`Erasing device...`)
      await simctl('erase', device.udid)
    }

    if (locale) {
      core.info(`Changing device locale to ${locale}...`)
      plutil(
        device.globalPreferencesPath,
        `-replace AppleLanguages -json '["${locale}"]'`
      )
    } else {
      // TODO make sure to reset the default locale in case it has changed
    }

    if (boolean(core.getInput('disable_apple_services'))) {
      core.info(`Disabling Apple services...`)
      plutil(device.globalPreferencesPath, `-replace AssistantEnabled -bool NO`)
      plutil(device.globalPreferencesPath, `-replace AppleIDDisabled -bool YES`)
      plutil(
        device.globalPreferencesPath,
        `-replace AutomaticDownloadEnabled -bool NO`
      )
    }
    plutil(
      device.globalPreferencesPath,
      `-replace UIBackgroundRefreshDisabled -bool YES`
    )

    if (boolean(core.getInput('shutdown_after_job'))) {
      core.saveState('udid', device.udid)
    }
    core.info(`Booting device.`)
    await simctl('boot', device.udid)

    if (core.getInput('wait_for_boot')) {
      if (core.getInput('wait_for_boot') === 'migration') {
        core.info(`Waiting for device to finish booting using data migration.`)
        while (true) {
          try {
            let result = ''
            core.info('Checking data migration status..')
            const command = `xcrun simctl spawn ${device.udid} log show --predicate 'eventMessage contains \\"com.apple.assetsd.migration\\"' | grep UserEventAgent | grep Completed | grep -v log`
            await exec.exec(`/bin/bash -c "${command}"`, [], {
              listeners: {
                stdout: (data: Buffer) => {
                  result += data.toString()
                }
              }
            })
            if (result.trim() !== '') {
              core.info(`Data migration finished.`)
              break
            }
          } catch (error) {
            core.warning(error instanceof Error ? error.message : String(error))
          }
          await new Promise(resolve => setTimeout(resolve, 2000))
        }
      } else {
        core.info(`Waiting for device to finish booting using bootstatus.`)
        await simctl('bootstatus', device.udid)
      }

      if (core.getInput('app_path') && core.getInput('app_bundle_id')) {
        core.info(`Installing ${core.getInput('app_bundle_id')}`)
        await install(
          core.getInput('app_path'),
          core.getInput('app_bundle_id'),
          device.udid
        )
      }
    }

    core.setOutput('udid', device.udid)
  } catch (error) {
    let errorMessage = 'Failed to run simulator-action (reason unknown)'
    if (error instanceof Error) {
      errorMessage = error.message
    }
    core.setFailed(errorMessage)
  }
}

async function cleanup(): Promise<void> {
  try {
    const udid = core.getState('udid')
    if (udid) {
      core.info(`Shutting down device ${udid}.`)
      await simctl('shutdown', udid)
    }
  } catch (error) {
    let errorMessage = 'Failed to cleanup simulator-action (reason unknown)'
    if (error instanceof Error) {
      errorMessage = error.message
    }
    core.setFailed(errorMessage)
  }
}

if (core.getState('post')) {
  cleanup()
} else {
  core.saveState('post', 'true')
  run()
}
