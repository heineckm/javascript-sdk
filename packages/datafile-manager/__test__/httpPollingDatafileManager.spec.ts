/**
 * Copyright 2019, Optimizely
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import HTTPPollingDatafileManager from '../src/httpPollingDatafileManager'
import { Headers, AbortableRequest, Response } from '../src/http'
import { DatafileManagerConfig } from '../src/datafileManager';
import TestTimeoutFactory from './testTimeoutFactory'

// Test implementation:
//   - Does not make any real requests: just resolves with queued responses (tests push onto queuedResponses)
class TestDatafileManager extends HTTPPollingDatafileManager {
  queuedResponses: Response[] = []

  responsePromises: Promise<Response>[] = []

  makeGetRequest(url: string, headers: Headers): AbortableRequest {
    const nextResponse: Response | undefined = this.queuedResponses.pop()
    let responsePromise: Promise<Response>
    if (nextResponse === undefined) {
      responsePromise = Promise.reject('No responses queued')
    } else {
      responsePromise = Promise.resolve(nextResponse)
    }
    this.responsePromises.push(responsePromise)
    return  { responsePromise, abort: jest.fn() }
  }
}

describe('httpPollingDatafileManager', () => {
  const testTimeoutFactory: TestTimeoutFactory = new TestTimeoutFactory()

  function createTestManager(config: DatafileManagerConfig): TestDatafileManager {
    return new TestDatafileManager({
      ...config,
      timeoutFactory: testTimeoutFactory
    })
  }

  let manager: TestDatafileManager
  afterEach(async () => {
    testTimeoutFactory.cleanup()

    if (manager) {
      manager.stop()
    }
    jest.restoreAllMocks()
  })

  describe('when constructed with sdkKey and datafile', () => {
    beforeEach(() => {
      manager = createTestManager({ datafile: 'abcd', sdkKey: '123' })
    })

    it('returns the passed datafile from get', () => {
      expect(manager.get()).toBe('abcd')
    })

    it('after being started, fetches the datafile and resolves onReady', async () => {
      manager.queuedResponses.push({
        statusCode: 200,
        body: '{"foo": "bar"}',
        headers: {}
      })
      manager.start()
      await manager.onReady()
      expect(manager.get()).toBe('{"foo": "bar"}')
    })
  })

  describe('when constructed with sdkKey only', () => {
    beforeEach(() => {
      manager = createTestManager({ sdkKey: '123', updateInterval: 10 })
    })

    describe('initial state', () => {
      it('returns null from get before becoming ready', () => {
        expect(manager.get()).toBeNull()
      })
    })

    describe('started state', () => {
      it('passes the default datafile URL to the makeGetRequest method', async () => {
        const makeGetRequestSpy = jest.spyOn(manager, 'makeGetRequest')
        manager.queuedResponses.push({
          statusCode: 200,
          body: '{"foo": "bar"}',
          headers: {},
        })
        manager.start()
        expect(makeGetRequestSpy).toBeCalledTimes(1)
        expect(makeGetRequestSpy.mock.calls[0][0]).toBe('https://cdn.optimizely.com/datafiles/123.json')
        await manager.onReady()
      })

      it('after being started, fetches the datafile and resolves onReady', async () => {
        manager.queuedResponses.push({
          statusCode: 200,
          body: '{"foo": "bar"}',
          headers: {},
        })
        manager.start()
        await manager.onReady()
        expect(manager.get()).toBe('{"foo": "bar"}')
      })

      describe('live updates', () => {
        it('passes the update interval to its timeoutFactory setTimeout method', async () => {
          manager.queuedResponses.push({
            statusCode: 200,
            body: '{"foo3": "bar3"}',
            headers: {},
          })

          const setTimeoutSpy: jest.SpyInstance<() => void, [() => void, number]> = jest.spyOn(testTimeoutFactory, 'setTimeout')

          manager.start()
          await manager.onReady()
          expect(setTimeoutSpy).toBeCalledTimes(1)
          expect(setTimeoutSpy.mock.calls[0][1]).toBe(10)
        })

        it('emits update events after live updates', async () => {
          manager.queuedResponses.push(
            {
              statusCode: 200,
              body: '{"foo3": "bar3"}',
              headers: {},
            },
            {
              statusCode: 200,
              body: '{"foo2": "bar2"}',
              headers: {},
            },
            {
              statusCode: 200,
              body: '{"foo": "bar"}',
              headers: {},
            },
          )

          const updateFn = jest.fn()
          manager.on('update', updateFn)

          manager.start()
          await manager.onReady()
          expect(manager.get()).toBe('{"foo": "bar"}')
          expect(updateFn).toBeCalledTimes(0)

          testTimeoutFactory.timeoutFns[0]()
          await manager.responsePromises[1]
          expect(updateFn).toBeCalledTimes(1)
          expect(updateFn.mock.calls[0][0]).toEqual({ datafile: '{"foo2": "bar2"}' })
          expect(manager.get()).toBe('{"foo2": "bar2"}')

          updateFn.mockReset()

          testTimeoutFactory.timeoutFns[1]()
          await manager.responsePromises[2]
          expect(updateFn).toBeCalledTimes(1)
          expect(updateFn.mock.calls[0][0]).toEqual({ datafile: '{"foo3": "bar3"}' })
          expect(manager.get()).toBe('{"foo3": "bar3"}')
        })

        it('cancels a pending timeout when stop is called', async () => {
          manager.queuedResponses.push(
            {
              statusCode: 200,
              body: '{"foo": "bar"}',
              headers: {},
            },
          )

          manager.start()
          await manager.onReady()

          expect(testTimeoutFactory.timeoutFns.length).toBe(1)
          expect(testTimeoutFactory.cancelFns.length).toBe(1)
          manager.stop()
          expect(testTimeoutFactory.cancelFns[0]).toBeCalledTimes(1)
        })

        it('cancels reactions to a pending fetch when stop is called', async () => {
          manager.queuedResponses.push(
            {
              statusCode: 200,
              body: '{"foo2": "bar2"}',
              headers: {},
            },
            {
              statusCode: 200,
              body: '{"foo": "bar"}',
              headers: {},
            },
          )

          manager.start()
          await manager.onReady()
          expect(manager.get()).toBe('{"foo": "bar"}')
          testTimeoutFactory.timeoutFns[0]()
          expect(manager.responsePromises.length).toBe(2)
          manager.stop()
          await manager.responsePromises[1]
          // Should not have updated datafile since manager was stopped
          expect(manager.get()).toBe('{"foo": "bar"}')
        })

        it('calls abort on the current request if there is a current request when stop is called', async () => {
          manager.queuedResponses.push(
            {
              statusCode: 200,
              body: '{"foo2": "bar2"}',
              headers: {},
            }
          )
          const makeGetRequestSpy = jest.spyOn(manager, 'makeGetRequest')
          manager.start()
          const currentRequest = makeGetRequestSpy.mock.results[0]
          expect(currentRequest.type).toBe('return')
          expect(currentRequest.value.abort).toBeCalledTimes(0)
          manager.stop()
          expect(currentRequest.value.abort).toBeCalledTimes(1)
        })

        it('can fail to become ready on the initial request, but succeed after a later polling update', async () => {
          manager.queuedResponses.push(
            {
              statusCode: 200,
              body: '{"foo": "bar"}',
              headers: {},
            },
            {
              statusCode: 404,
              body: '',
              headers: {}
            }
          )

          manager.start()
          expect(manager.responsePromises.length).toBe(1)
          await manager.responsePromises[0]
          // Not ready yet due to first request failed, but should have queued a live update
          expect(testTimeoutFactory.timeoutFns.length).toBe(1)
          // Trigger the update, should fetch the next response which should succeed, then we get ready
          testTimeoutFactory.timeoutFns[0]()
          await manager.onReady()
          expect(manager.get()).toBe('{"foo": "bar"}')
        })

        describe('newness checking', () => {
          it('does not update if the response status is 304', async () => {
            manager.queuedResponses.push(
              {
                statusCode: 304,
                body: '',
                headers: {},
              },
              {
                statusCode: 200,
                body: '{"foo": "bar"}',
                headers: {
                  'Last-Modified': 'Fri, 08 Mar 2019 18:57:17 GMT',
                },
              }
            )

            const updateFn = jest.fn()
            manager.on('update', updateFn)

            manager.start()
            await manager.onReady()
            expect(manager.get()).toBe('{"foo": "bar"}')
            // First response promise was for the initial 200 response
            expect(manager.responsePromises.length).toBe(1)
            // Trigger the queued update
            testTimeoutFactory.timeoutFns[0]()
            // Second response promise is for the 304 response
            expect(manager.responsePromises.length).toBe(2)
            await manager.responsePromises[1]
            // Since the response was 304, updateFn should not have been called
            expect(updateFn).toBeCalledTimes(0)
            expect(manager.get()).toBe('{"foo": "bar"}')
          })

          it('sends if-modified-since using the last observed response last-modified', async () => {
            manager.queuedResponses.push(
              {
                statusCode: 304,
                body: '',
                headers: {},
              },
              {
                statusCode: 200,
                body: '{"foo": "bar"}',
                headers: {
                  'Last-Modified': 'Fri, 08 Mar 2019 18:57:17 GMT',
                },
              }
            )
            manager.start()
            await manager.onReady()
            const makeGetRequestSpy = jest.spyOn(manager, 'makeGetRequest')
            testTimeoutFactory.timeoutFns[0]()
            expect(makeGetRequestSpy).toBeCalledTimes(1)
            const firstCall = makeGetRequestSpy.mock.calls[0]
            const headers = firstCall[1]
            expect(headers).toEqual({
              'if-modified-since': 'Fri, 08 Mar 2019 18:57:17 GMT',
            })
          })
        })
      })
    })
  })

  describe('when constructed with sdkKey and liveUpdates: false', () => {
    beforeEach(() => {
      manager = createTestManager({ sdkKey: '123', liveUpdates: false })
    })

    it('after being started, fetches the datafile and resolves onReady', async () => {
      manager.queuedResponses.push({
        statusCode: 200,
        body: '{"foo": "bar"}',
        headers: {},
      })
      manager.start()
      await manager.onReady()
      expect(manager.get()).toBe('{"foo": "bar"}')
    })

    it('does not schedule a live update after ready', async () => {
      manager.queuedResponses.push({
        statusCode: 200,
        body: '{"foo": "bar"}',
        headers: {},
      })
      const updateFn = jest.fn()
      manager.on('update', updateFn)
      manager.start()
      await manager.onReady()
      expect(testTimeoutFactory.timeoutFns.length).toBe(0)
    })

    // TODO: figure out what's wrong with this test
    it.skip('rejects the onReady promise if the initial request promise rejects', async () => {
      manager.queuedResponses.push({
        statusCode: 200,
        body: '{"foo": "bar"}',
        headers: {},
      })
      manager.makeGetRequest = () => ({ abort() {}, responsePromise: Promise.reject(new Error('Could not connect')) })
      manager.start()
      let didReject = false
      try {
        await manager.onReady()
      } catch (e) {
        didReject = true
      }
      expect(didReject).toBe(true)
    })
  })

  describe('when constructed with sdkKey and a valid urlTemplate', () => {
    beforeEach(() => {
      manager = createTestManager({
        sdkKey: '456',
        updateInterval: 10,
        urlTemplate: 'https://localhost:5556/datafiles/$SDK_KEY',
      })
    })

    it('uses the urlTemplate to create the url passed to the makeGetRequest method', async () => {
      const makeGetRequestSpy = jest.spyOn(manager, 'makeGetRequest')
      manager.queuedResponses.push({
        statusCode: 200,
        body: '{"foo": "bar"}',
        headers: {},
      })
      manager.start()
      expect(makeGetRequestSpy).toBeCalledTimes(1)
      expect(makeGetRequestSpy.mock.calls[0][0]).toBe('https://localhost:5556/datafiles/456')
      await manager.onReady()
    })
  })
})