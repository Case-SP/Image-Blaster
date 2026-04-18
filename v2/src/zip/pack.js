const archiver = require('archiver');

/**
 * Build an in-memory ZIP of images.
 * `files` is an array of { filename, buffer }.
 * Returns a Promise<Buffer>.
 */
function packZip(files, { zipName = 'images' } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('data', c => chunks.push(c));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('warning', err => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);
    for (const { filename, buffer } of files) {
      if (buffer) archive.append(buffer, { name: filename });
    }
    archive.finalize();
  });
}

module.exports = { packZip };
