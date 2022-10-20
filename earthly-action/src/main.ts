import * as core from '@actions/core'
import * as tc from '@actions/tool-cache'
import * as exec from '@actions/exec'
import {chmodSync, readFileSync} from 'fs'

const earthlyToolName = 'earthly'
const earthlyBinary = 'earthly'
const earthlyVersion = '0.6.23'

async function ensureEarthlyInPATH(): Promise<void> {
  let earthlyPath = tc.find(earthlyToolName, earthlyVersion)
  if (earthlyPath !== '') {
    core.debug('Found cached earthly install, hooray!')
    core.addPath(earthlyPath)
    return
  }

  const d = await tc.downloadTool(
    `https://github.com/earthly/earthly/releases/download/v${earthlyVersion}/earthly-linux-amd64`
  )
  chmodSync(d, 0o755)

  earthlyPath = await tc.cacheFile(
    d,
    earthlyBinary,
    earthlyToolName,
    earthlyVersion
  )
  core.addPath(earthlyPath)
}

function getDefaultArgs(ctx: Context): string[] {
  const args = ['--strict', '--allow-privileged']

  if (ctx.pullRequestID) {
    const topicCacheImage = `${ctx.cacheOCIRegistry}/${ctx.repository}:pr-${ctx.pullRequestID}`
    const baseCacheImage = `${ctx.cacheOCIRegistry}/${ctx.repository}:main` // TODO: What if repo's main branch is not `main`?

    args.push(
      `--remote-cache=${topicCacheImage}`,
      `--cache-from=${baseCacheImage}`
    )
  } else {
    const topicCacheImage = `${ctx.cacheOCIRegistry}/${ctx.repository}:${ctx.branch}` // TODO: sanitize docker tag? should only be `main` or `master`
    args.push(`--remote-cache=${topicCacheImage}`)
  }

  return args
}

class Context {
  repository: string
  branch: string
  ociRegistry: string
  cacheOCIRegistry: string
  pullRequestID: string | undefined

  constructor() {
    // See https://docs.github.com/en/actions/learn-github-actions/environment-variables#default-environment-variables
    this.repository = process.env.GITHUB_REPOSITORY as string
    this.branch = process.env.GITHUB_REF_NAME as string

    // The following variables are available in the self-hosted runner
    this.ociRegistry = process.env.OCI_REGISTRY as string
    this.cacheOCIRegistry = process.env.CACHE_OCI_REGISTRY as string

    // "Inspired" by https://github.com/actions/toolkit/blob/main/packages/github/src/context.ts
    if (!process.env.GITHUB_EVENT_PATH) {
      throw new Error(
        'GITHUB_EVENT_PATH is not set! We cannot get contextual information without that file.'
      )
    }
    const rawEvent = readFileSync(process.env.GITHUB_EVENT_PATH, {
      encoding: 'utf8'
    })

    const event = JSON.parse(rawEvent)

    // https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#pull_request
    if ('pull_request' in event) {
      this.pullRequestID = event.pull_request.number
    }
  }
}

async function run(): Promise<void> {
  try {
    const ctx = new Context()

    const env = {
      ...{
        NO_DOCKER: '1',
        FORCE_COLOR: '1'
      },
      ...process.env
    }

    const args = getDefaultArgs(ctx)

    if (core.getBooleanInput('push')) {
      args.push('--push')
    }

    const defaultBuildArgs = {
      OCI_REGISTRY: ctx.ociRegistry
    }

    const buildArgs = {
      ...defaultBuildArgs,
      ...JSON.parse(core.getInput('buildArgs'))
    }

    for (const key in buildArgs) {
      args.push(`--build-arg=${key}=${buildArgs[key]}`) // TODO: handle escaping and such
    }

    const secrets = JSON.parse(core.getInput('secrets'))
    for (const key in secrets) {
      args.push(`--secret=${key}=${secrets[key]}`) // This won't do, probably need a custom secret provider for Earthly, or something...
    }

    const target = core.getInput('target')
    args.push(target)

    await ensureEarthlyInPATH()

    core.info('Running earthly --version')
    exec.exec(earthlyBinary, ['--version'], {env})

    core.info(`Running Earthly target ${target}`)
    exec.exec(earthlyBinary, args, {env})
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    }
  }
}

run()
