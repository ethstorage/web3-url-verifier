import { KZG } from 'js-kzg';
import * as ethers from 'ethers';

const BLOB_SIZE = 131072;
const MaxBlobDataSize = (4 * 31 + 3) * 1024 - 4; // 130044
const EncodingVersion = 0;
const Rounds = 1024;

let _kzg: Awaited<ReturnType<typeof KZG.create>> | null = null;

export async function getKzg() {
  if (_kzg) return _kzg;
  _kzg = await KZG.create();
  return _kzg;
}

function copy(des: Uint8Array, desOff: number, src: Uint8Array, srcOff: number) {
  const srcLen = src.length - srcOff;
  const desLen = des.length - desOff;
  const len = Math.min(srcLen, desLen);
  for (let i = 0; i < len; i++) des[desOff + i] = src[srcOff + i];
  return len;
}

function encodeOpBlob(data: Uint8Array): Uint8Array {
  if (data.length > MaxBlobDataSize) {
    throw new Error(`too much data to encode in one blob, len=${data.length}`);
  }
  const b = new Uint8Array(BLOB_SIZE);
  let readOffset = 0;

  const read1 = () => (readOffset >= data.length ? 0 : data[readOffset++]);

  let writeOffset = 0;
  const buf31 = new Uint8Array(31);

  const read31 = () => {
    if (readOffset >= data.length) {
      buf31.fill(0);
      return;
    }
    const n = copy(buf31, 0, data, readOffset);
    buf31.fill(0, n);
    readOffset += n;
  };

  const write1 = (v: number) => { b[writeOffset++] = v; };
  const write31 = () => { copy(b, writeOffset, buf31, 0); writeOffset += 31; };

  for (let round = 0; round < Rounds && readOffset < data.length; round++) {
    if (round === 0) {
      buf31[0] = EncodingVersion;
      const ilen = data.length;
      buf31[1] = (ilen >> 16) & 0xFF;
      buf31[2] = (ilen >> 8) & 0xFF;
      buf31[3] = ilen & 0xFF;
      readOffset += copy(buf31, 4, data, 0);
    } else {
      read31();
    }
    const x = read1();
    const A = x & 0b0011_1111;
    write1(A);
    write31();

    read31();
    const y = read1();
    const B = (y & 0b0000_1111) | ((x & 0b1100_0000) >> 2);
    write1(B);
    write31();

    read31();
    const z = read1();
    const C = z & 0b0011_1111;
    write1(C);
    write31();

    read31();
    const D = ((z & 0b1100_0000) >> 2) | ((y & 0b1111_0000) >> 4);
    write1(D);
    write31();
  }

  return b;
}

function encodeOpBlobs(data: Uint8Array): Uint8Array[] {
  if (data.length === 0) throw new Error('invalid blob data');
  const blobs: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += MaxBlobDataSize) {
    const end = Math.min(i + MaxBlobDataSize, data.length);
    blobs.push(encodeOpBlob(data.subarray(i, end)));
  }
  return blobs;
}

function convertToEthStorageHash(commitment: Uint8Array): string {
  const versionedHash = new Uint8Array(32);
  versionedHash[0] = 0x01;
  const sha = ethers.getBytes(ethers.sha256(commitment));
  versionedHash.set(sha.subarray(1), 1);
  const hash = new Uint8Array(32);
  hash.set(versionedHash.subarray(0, 24));
  return ethers.hexlify(hash);
}

export async function computeEthStorageHashes(fileData: Uint8Array) {
  const kzg = await getKzg();
  const blobs = encodeOpBlobs(fileData);
  const hashes: string[] = [];
  for (const blob of blobs) {
    const commitment = await kzg.computeCommitment(blob);
    hashes.push(convertToEthStorageHash(commitment as any));
  }
  return { hashes, chunkCount: blobs.length };
}