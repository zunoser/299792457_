import {spawn} from 'node:child_process'
import {readdir, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {TwitterClient} from '@yuta/bird'

const USERNAME = '299792457_'
const RELAY_BASE_URL = 'https://tw.home.yutakobayashi.com'
const RELAY_PROFILE = 'account2'
const PAGE_SIZE = 20
const MAX_NEW_POSTS = 40
const CONSECUTIVE_EXISTING_THRESHOLD = 5
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const snapshotsRoot = join(repositoryRoot, 'snapshots')

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const randomDelay = (minimum, maximum) => Math.floor(Math.random() * (maximum - minimum) + minimum)

async function findSnapshotIds(directory) {
  const ids = new Set()
  let entries
  try {
    entries = await readdir(directory, {withFileTypes: true})
  } catch (error) {
    if (error.code === 'ENOENT') return ids
    throw error
  }

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      for (const id of await findSnapshotIds(path)) ids.add(id)
    } else if (entry.isFile() && /^\d+\.png$/.test(entry.name)) {
      ids.add(entry.name.slice(0, -4))
    }
  }
  return ids
}

async function collectNewPostIds(existingIds) {
  const client = new TwitterClient({relayBaseUrl: RELAY_BASE_URL, profileName: RELAY_PROFILE})
  const user = await client.getUserIdByUsername(USERNAME)
  if (!user.success || !user.userId) throw new Error(user.error ?? 'User lookup failed')

  const collected = []
  const seenPostIds = new Set()
  const seenCursors = new Set()
  let cursor
  let consecutiveExisting = 0

  while (collected.length < MAX_NEW_POSTS) {
    const result = await client.getUserTweetsPaged(user.userId, PAGE_SIZE, {
      cursor,
      maxPages: 1,
      pageDelayMs: 0,
    })
    if (!result.success) throw new Error(result.error)

    for (const post of result.tweets) {
      if (!/^\d+$/.test(post.id)) throw new Error('Bird returned an invalid post ID')
      if (seenPostIds.has(post.id)) continue
      seenPostIds.add(post.id)
      if (existingIds.has(post.id)) {
        consecutiveExisting += 1
        if (consecutiveExisting >= CONSECUTIVE_EXISTING_THRESHOLD) return collected
        continue
      }

      consecutiveExisting = 0
      collected.push(post.id)
      if (collected.length >= MAX_NEW_POSTS) return collected
    }

    if (!result.nextCursor) return collected
    if (seenCursors.has(result.nextCursor)) throw new Error('Bird returned a repeated cursor')
    seenCursors.add(result.nextCursor)
    cursor = result.nextCursor
    await sleep(randomDelay(2_000, 5_000))
  }

  return collected
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {...process.env, XDG_CACHE_HOME: join(tmpdir(), '299792457-twitter-snap-cache')},
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`twitter-snap exited with ${code}`)))
  })
}

const existingIds = await findSnapshotIds(snapshotsRoot)
const postIds = await collectNewPostIds(existingIds)

if (postIds.length === 0) {
  console.log('No new posts.')
  process.exit(0)
}

for (const [index, postId] of postIds.entries()) {
  await run(join(repositoryRoot, 'node_modules', '.bin', 'twitter-snap'), [
    `https://x.com/i/status/${postId}`,
    '--session-type', 'guest',
    '--limit', '1',
    '--theme', 'RenderOceanBlueColor',
    '--output', join(snapshotsRoot, '{time-yyyy}', '{time-mm}', '{id}.png'),
    '--simple-log',
  ])

  const updatedIds = await findSnapshotIds(snapshotsRoot)
  if (!updatedIds.has(postId)) throw new Error(`twitter-snap produced no PNG for ${postId}`)
  const paths = await findSnapshotPaths(snapshotsRoot, postId)
  if (paths.length !== 1 || (await stat(paths[0])).size === 0) throw new Error(`Invalid PNG for ${postId}`)

  if (index + 1 < postIds.length) await sleep(randomDelay(1_000, 3_000))
}

console.log(`Archived ${postIds.length} new posts.`)

async function findSnapshotPaths(directory, postId) {
  const paths = []
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await findSnapshotPaths(path, postId))
    else if (entry.isFile() && entry.name === `${postId}.png`) paths.push(path)
  }
  return paths
}
