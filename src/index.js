import {EventEmitter} from 'events'
import path from 'path'
import readPkg from 'read-pkg'
import Bottleneck from 'bottleneck'
import fsp from 'fs-promise'

export default class TreeWalker extends EventEmitter {
  static get DEFAULT_OPTIONS () {
    return {
      concurrency: 10
    }
  }

  constructor (pkgRoot, options) {
    super()
    this._pkgRoot = pkgRoot
    this._options = Object.assign({}, TreeWalker.DEFAULT_OPTIONS, options)
    this._limiter = new Bottleneck(this._options.concurrency)
    this._taskCount = 0
    this._boundWalk = this._walk.bind(this)
    this._boundFindDependency = this._findDependency.bind(this)
    this._boundAfterTask = this._afterTask.bind(this)
  }

  run () {
    this._taskCount = 0
    this._schedule(this._boundWalk, ['.'])
  }

  async _walk (trail, parentMeta = null) {
    const relPath = this._trailToRelPkgPath(trail)
    const pkg = await readPkg(this._relToAbsPkgPath(relPath))
    const pkgMeta = {
      name: pkg.name,
      version: pkg.version,
      format: 'cjs',
      main: pkg.main || 'index.js',
      path: relPath,
      parent: parentMeta
    }

    this.emit('data', pkgMeta)

    const deps = pkg.dependencies || {}
    for (const dep of Object.keys(deps)) {
      this._schedule(this._boundFindDependency, dep, trail, pkgMeta)
    }
  }

  async _findDependency (dep, trail, pkgMeta) {
    const currentTrail = trail.slice()

    while (currentTrail.length > 0 && !(await this._trailHasPkg([...currentTrail, dep]))) {
      currentTrail.pop()
    }

    if (currentTrail.length === 0) {
      throw new Error(`Dependency not found in node_modules: ${dep}`)
    }

    this._schedule(this._boundWalk, [...currentTrail, dep], pkgMeta)
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
    if (error != null) {
      this.emit('error', error)
    } else if (this._taskCount === 0) {
      this.emit('end')
    }
  }
}
