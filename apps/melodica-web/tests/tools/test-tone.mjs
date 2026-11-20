export function wavBytes(seconds = 30, frequency = 440) {
  const rate = 48_000, samples = rate * seconds, header = Buffer.alloc(44), pcm = Buffer.alloc(samples * 2);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  for (let i = 0; i < samples; i += 1) pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * frequency * i / rate) * 9_000), i * 2);
  return Buffer.concat([header, pcm]);
}
