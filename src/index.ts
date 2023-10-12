import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import fs from 'node:fs'
import child_process from 'node:child_process'
import { EventEmitter } from 'node:events'

function getRandomInt(min: number, max: number) {
  min = Math.ceil(min)
  max = Math.floor(max)

  return Math.floor(Math.random() * (max - min) + min) // The maximum is exclusive and the minimum is inclusive
}

export const STARTUP_TIMEOUT = 3000

export enum S3MemoryServerState {
  NEW = 'new',
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPED = 'stopped',
}

export enum Events {
  stdout = 'stdout',
  stderr = 'stderr',
  state_change = 'state_change'
}

export enum OS {
  WINDOWS = 'windows',
  DARWIN = 'darwin',
  LINUX = 'linux',
}

export enum ARCH {
  ARM64 = 'arm64',
  AMD64 = 'amd64',
}

class ProgressPrinter {
  private currentBytes = 0
  private lastPrintedAt = 0

  constructor(
    private totalBytes: number,
    private crReturn: string,
  ) {
    this.update({ length: 0 }, true)
  }

  update(chunk: { length: number }, forcePrint: boolean = false) {
    this.currentBytes += chunk.length

    const now = Date.now()

    if (now - this.lastPrintedAt < 2000 && !forcePrint)
      return

    this.lastPrintedAt = now

    const percentComplete = Math.round(((100 * this.currentBytes) / this.totalBytes) * 10) / 10
    const mbComplete = Math.round((this.currentBytes / 1_000_000) * 10) / 10
    const mbTotal = Math.round((this.totalBytes / 1_000_000) * 10) / 10
    const message = `Downloading MinIO: ${percentComplete}% (${mbComplete}mb / ${mbTotal}mb)${this.crReturn}`
    process.stdout.write(message)
  }

  finish() {
    this.update({ length: 0 }, true)
    const message = '\nMinIO downloaded!\n'
    process.stdout.write(message)
  }
}

export class MinIOBinary {
  static async install() {
    const opts = this.createOpts()

    if (this.fileExists(opts.downloadPath)) {
      this.setFileMod(opts.downloadPath)
      return opts.downloadPath
    }

    this.assertPermission(opts.downloadDir)
    await this.download({ url: opts.binaryUrl, downloadPath: opts.downloadPath })
    this.setFileMod(opts.downloadPath)
    return opts.downloadPath
  }

  private static createOpts() {
    const platform = os.platform()
    const arch = os.arch()

    const archMapping = {
      arm64: ARCH.ARM64,
      x64: ARCH.AMD64,
    }
    const platformMapping = {
      darwin: OS.DARWIN,
      linux: OS.LINUX,
      win32: OS.WINDOWS,
    }

    const expectedArch = [...Object.keys(archMapping)]
    const expectedPlatform = [...Object.keys(platformMapping)]

    if (!expectedArch.includes(arch))
      throw new Error(`expected one of architecture [${expectedArch.join(', ')}].got '${arch}'`)

    if (!expectedPlatform.includes(platform))
      throw new Error(`expected one of platform [${expectedPlatform.join(', ')}].got '${platform}'`)

    const _os = platformMapping[platform as keyof typeof platformMapping]
    const _arch = archMapping[arch as keyof typeof archMapping]

    //const downloadDir = '/home/arthur/.cache/s3-binaries'
    const extension = _os === OS.WINDOWS ? '.exe' : ''
    const downloadDir = path.join(os.tmpdir(), 's3-binaries')
    fs.mkdirSync(downloadDir, { mode: 0o775, recursive: true })
    const downloadPath = path.join(downloadDir, `minio-${_os}-${_arch}-latest${extension}`)
    const binaryUrl = `https://dl.min.io/server/minio/release/${_os}-${_arch}/minio${extension}`

    return {
      os: _os,
      arch: _arch,
      downloadDir,
      downloadPath,
      binaryUrl,
    }
  }

  private static fileExists(path: string) {
    try {
      return fs.statSync(path).isFile()
    } catch {
      return false
    }
  }

  private static assertPermission(downloadDir: string) {
    try {
      fs.accessSync(downloadDir, fs.constants.X_OK | fs.constants.W_OK);
    } catch (err) {
      console.error(
        `Download Directory at "${downloadDir}" does not have sufficient permissions to be used by this process\n` +
          'Needed Permissions: Write & Execute (-wx)\n'
      )
      throw err
    }
  }

  private static setFileMod(downloadPath: string) {
    return fs.chmodSync(downloadPath, 0o775)
  }

  static download(opts: { url: string, downloadPath: string }) {
    const tempPath = `${opts.downloadPath}-${Date.now()}`

    return new Promise((resolve, reject) => {
      https.get(opts.url, (response) => {
        if (response.statusCode !== 200)
          return reject(new Error(`got HTTP status code ${response.statusCode}`))

        const crReturn = false ? '\x1b[0G' : '\r';

        const progressPrinter = new ProgressPrinter(parseInt(response.headers['content-length'] ?? '0', 10), crReturn)

        const fileStream = fs.createWriteStream(tempPath)

        response.pipe(fileStream)

        response.on('data', (chunk) => {
          progressPrinter.update({ length: chunk.length })
        })

        fileStream.on('finish', async () => {
          fileStream.close()
          fs.renameSync(tempPath, opts.downloadPath)
          progressPrinter.finish()

          resolve(opts.downloadPath)
        })

      }).on('error', (e) => {
        console.error(e)
        reject(e)
      })
    })
  }
}


export interface S3MemoryServerOptions {
  binaryPath: string
  tempPaths: {
    home: string
    data: string
    certs: string
  }
  auth: {
    user: string
    password: string
  }
  addresses: {
    api: number,
    console: number,
  }
}

export class S3MemoryServer {
  private _state: S3MemoryServerState
  private process: child_process.ChildProcess
  private events = new EventEmitter()

  constructor(private options: S3MemoryServerOptions) {
    this._state = S3MemoryServerState.NEW
  }

  static async create(options: Pick<S3MemoryServerOptions, 'auth'> & { addresses?: Partial<S3MemoryServerOptions['addresses']> }) {
    const binaryPath = await MinIOBinary.install()

    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 's3-mem-'))
    const dataPath = path.join(tempPath, 'data')
    const certsPath = path.join(tempPath, 'certs')
    fs.mkdirSync(dataPath, 0o775)
    fs.mkdirSync(certsPath, 0o775)

    if (!options.addresses)
      options.addresses = { api: 9000, console: 9090 }

    if (typeof options.addresses.api !== 'number')
      options.addresses.api = 9000

    if (typeof options.addresses.console !== 'number')
      options.addresses.console = 9090

    if (options.addresses.api === 0)
      options.addresses.api = getRandomInt(1024, 40000)

    if (options.addresses.console === 0)
      options.addresses.console = getRandomInt(1024, 40000)

    const instance = new S3MemoryServer({
      binaryPath,
      tempPaths: {
        home: tempPath,
        data: dataPath,
        certs: certsPath,
      },
      auth: options.auth,
      addresses: options.addresses as any,
    })

    await instance.start()

    return instance
  }

  getUris() {
    const prefix = `http://${this.options.auth.user}:${this.options.auth.password}@127.0.0.1`

    return {
      api: `${prefix}:${this.options.addresses.api}`,
      console: `${prefix}:${this.options.addresses.console}`,
    }
  }

  get state() {
    return this._state
  }

  async start() {
    this.process = await this.launch(this.options.binaryPath)

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.events.removeListener(Events.state_change, listener_state)
        this.events.removeListener(Events.stdout, listener_stdout)
        reject(new Error('MinIO server startup timeout'))
      }, STARTUP_TIMEOUT)

      const listener_state = () => {
        if (this._state !== S3MemoryServerState.RUNNING) return

        clearTimeout(timeout)
        this.events.removeListener(Events.state_change, listener_state)
        this.events.removeListener(Events.stdout, listener_stdout)
        resolve()
      }

      const listener_stdout = (message: string) => {
        if (!message.includes('Specified port is already in use')) return

        clearTimeout(timeout)
        this.events.removeListener(Events.state_change, listener_state)
        this.events.removeListener(Events.stdout, listener_stdout)
        this.cleanup()
        reject(new Error('Port already in use'))
      }

      this.events.on(Events.state_change, listener_state)
      this.events.on(Events.stdout, listener_stdout)
    })
  }

  private cleanup() {
    fs.rmSync(this.options.tempPaths.home, { recursive: true, force: true })
  }

  async stop() {
    this.process.kill('SIGTERM')

    return new Promise<void>((resolve) => {
      const listener = () => {
        if (this._state === S3MemoryServerState.STOPPED) {
          this.events.removeListener(Events.state_change, listener)
          this.cleanup()
          resolve()
        }
      }

      this.events.on(Events.state_change, listener)
    })
  }

  private createCommandArgs() {
    // minio [FLAGS] COMMAND [ARGS...]
    const args: string[] = []

    const dataPath = this.options.tempPaths.data
    const certsPath = this.options.tempPaths.certs

    // [FLAGS]
    args.push(`--certs-dir=${certsPath}`)

    // COMMAND
    args.push('server')

    // [ARGS...]
    args.push(dataPath)
    args.push(`--address=:${this.options.addresses?.api}`)
    args.push(`--console-address=:${this.options.addresses?.console}`)

    return args
  }

  private async launch(binaryPath: string): Promise<child_process.ChildProcess> {
    if ([S3MemoryServerState.STARTING, S3MemoryServerState.RUNNING].includes(this._state)) {
      console.log(`server already ${this._state}`)

      return this.process
    }

    this._state = S3MemoryServerState.STARTING
    const childProcess = child_process.spawn(path.resolve(binaryPath), this.createCommandArgs(), {
      env: {
        HOME: this.options.tempPaths.home,
        MINIO_API_ROOT_ACCESS: 'on',
        MINIO_ROOT_USER: this.options.auth.user,
        MINIO_ROOT_PASSWORD: this.options.auth.password,
      },
      stdio: 'pipe',
    })

    childProcess.stdout?.on('data', (chunk: Buffer) => {
      const stdout = chunk.toString('utf8')
      console.log(stdout)
      this.events.emit(Events.stdout, stdout)

      if (stdout.includes('Status:         1 Online, 0 Offline.'))
        this.events.emit(Events.state_change, this._state = S3MemoryServerState.RUNNING)

      if (stdout.includes('Exiting on signal:'))
        this.events.emit(Events.state_change, this._state = S3MemoryServerState.STOPPED)
    })

    childProcess.stderr?.on('data', (chunk: Buffer) => {
      const stderr = chunk.toString('utf8')
      console.error(stderr)
      this.events.emit(Events.stderr, stderr)
    })

    //childProcess.on('close', this.closeHandler.bind(this))
    //childProcess.on('error', this.errorHandler.bind(this))

    if (typeof childProcess.pid !== 'number')
      throw new Error(`failed to launch ${binaryPath}`)

    return childProcess
  }
}

export default S3MemoryServer

async function main() {
  const memoryServer = await S3MemoryServer.create({
    auth: {
      user: 'admin123',
      password: 'admin123',
    },
    addresses: {
      api: 0,
      console: 0,
    }
  })

  console.log(memoryServer.getUris())
  //process.prependListener('SIGTERM', () => memoryServer.stop()) // default kill signal
  process.prependListener('SIGINT', () => memoryServer.stop()) // Ctrl-C signal
}

// called as a module, instead of being imported
if (require.main === module)
  main()
