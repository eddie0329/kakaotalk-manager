import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { parseAttachment } from './attachment-parser';
void parseAttachment(readFileSync(workerData.path), workerData.extension).then(
  result => parentPort?.postMessage({ result }),
  error => parentPort?.postMessage({ error: error instanceof Error && /[가-힣]/.test(error.message) ? error.message : '자료를 읽지 못했습니다. 암호·손상·지원되는 형식인지 확인하고, 필요한 부분을 PDF나 사진으로 연결해주세요.' })
);
