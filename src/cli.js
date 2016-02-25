#!/usr/bin/env node

import TreeWalker from './'

const walker = new TreeWalker(process.cwd())

walker.on('data', (pkg) => console.info(pkg))
walker.once('end', () => console.info('done'))
walker.once('error', (err) => console.error(err))

walker.run()
