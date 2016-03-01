import {EventEmitter} from 'events'
import path from 'path'
import readPkg from 'read-pkg'
import Bottleneck from 'bottleneck'
import fsp from 'fs-promise'

const MAIN_KEYS = ['main', 'jsnext:main', 'browser']

export default class TreeWalker extends EventEmitter {
  static get DEFAULT_OPTIONS () {
    return {
      concurrency: 10,
      dev: false
    }
  }

  constructor (pkgRoot, options) {
    super()
    this._pkgRoot = pkgRoot
    this._options = Object.assign({}, TreeWalker.DEFAULT_OPTIONS, options)
    this._limiter = new Bottleneck(this._options.concurrency)
    this._taskCount = 0
    this._seen = null
    this._boundWalk = this._walk.bind(this)
    this._boundFindDependency = this._findDependency.bind(this)
    this._boundAfterTask = this._afterTask.bind(this)
  }

  run () {
    this._taskCount = 0
    this._seen = Object.create(null)
    this._schedule(this._boundWalk, ['.'])
  }

  async _walk (trail, parentMeta = null) {
    const relPath = this._trailToRelPkgPath(trail)

    const pkg = await readPkg(this._relToAbsPkgPath(relPath))
    const pkgMeta = {
      name: pkg.name,
      version: pkg.version,
      path: relPath,
      parent: parentMeta
    }
    const existingKeys = MAIN_KEYS.filter((key) => !!pkg[key])
    for (const key of existingKeys) {
      pkgMeta[key] = pkg[key]
    }

    this.emit('data', pkgMeta)

    if (this._seen[relPath]) {
      return
    }
    this._seen[relPath] = true

    const deps = (this._options.dev && parentMeta == null)
      ? Object.assign({}, pkg.dependencies, pkg.devDependencies)
      : pkg.dependencies
    for (const dep of Object.keys(deps)) {
      const isOpt = (pkg.optionalDependencies != null && !!pkg.optionalDependencies[dep])
      this._schedule(this._boundFindDependency, dep, isOpt, trail, pkgMeta)
    }
  }

  async _findDependency (dep, isOpt, trail, pkgMeta) {
    const currentTrail = trail.slice()

    while (currentTrail.length > 0 && !(await this._trailHasPkg([...currentTrail, dep]))) {
      currentTrail.pop()
    }

    if (currentTrail.length > 0) {
      this._schedule(this._boundWalk, [...currentTrail, dep], pkgMeta)
    } else if (!isOpt) {
      throw new Error(`Dependency not found in node_modules: ${dep}`)
    }
  }

  async _trailHasPkg (trail) {
    const pkgPath = this._relToAbsPkgPath(this._trailToRelPkgPath(trail))

    try {
      return (await fsp.stat(pkgPath)).isDirectory()
    } catch (err) {
      if (err.code === 'ENOENT') {
        return false
      } else {
        throw err
      }
    }
  }

  _trailToRelPkgPath (trail) {
    return trail.reduce((a, b) => path.join(a, 'node_modules', b))
  }

  _relToAbsPkgPath (relPath) {
    return path.join(this._pkgRoot, relPath)
  }

  _schedule (fn, ...args) {
    this._beforeTask()
    this._limiter.schedule(fn, ...args)
      .then(this._boundAfterTask, this._boundAfterTask)
  }

  _beforeTask () {
    this._taskCount++
  }

  _afterTask (error = null) {
    this._taskCount--
    if (error != null || this._taskCount === 0) {
      this._onEnd(error)
    }
  }

  _onEnd (error) {
    this._seen = null
    if (error != null) {
      this.emit('error', error)
    } else {
      this.emit('end')
    }
  }
}
