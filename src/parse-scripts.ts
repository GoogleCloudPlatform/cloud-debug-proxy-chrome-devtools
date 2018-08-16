/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as fs from 'fs';
import * as globby from 'globby';
import {Runtime} from 'inspector';
import * as path from 'path';
import * as devtools from './adapter';
import split = require('split');
import pLimit = require('p-limit');

type FilePath = string;
interface ScriptInfo {
  scriptId: Runtime.ScriptId;
  endLine: devtools.ZeroIndexedLineNumber;
}

const CONCURRENCY = 10;

async function getScriptInfo(scriptId: Runtime.ScriptId): Promise<ScriptInfo> {
  return new Promise<ScriptInfo>((resolve, reject) => {
    let numberOfLines = 0;
    fs.createReadStream(scriptId, 'utf8')
        .pipe(split())
        .on('data', () => numberOfLines += 1)
        .on('end', () => resolve({scriptId, endLine: numberOfLines}))
        .on('error', reject);
  });
}

export async function parseScripts(sendEvent: Function, cwd: FilePath) {
  const limit = pLimit(CONCURRENCY);
  const fileList =
      await globby(['**/*.js', '**/*.ts', '!**/node_modules/**'], {cwd});
  // `scriptId` must be an absolute path to the file in order
  // for `getScriptSource` requests to work in adapter.ts.
  const scriptInfoList = await Promise.all(fileList.map(
      (filePath: FilePath) =>
          limit(() => getScriptInfo(path.resolve(cwd, filePath)))));
  scriptInfoList.forEach((scriptInfo: ScriptInfo) => {
    sendEvent({
      method: 'Debugger.scriptParsed',
      params: {
        scriptId: scriptInfo.scriptId,
        url: scriptInfo.scriptId,
        startLine: 0,
        startColumn: 0,
        endLine: scriptInfo.endLine,
        endColumn: 0,
        executionContextId: 0,
        hash: '',
      },
    });
  });
}
