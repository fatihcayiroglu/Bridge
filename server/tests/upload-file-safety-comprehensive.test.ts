import fs from 'fs';
import os from 'os';
import path from 'path';
import {canonicalExtensionForMime,checkMagicBytes} from '../lib/uploadFileSafety';

function withFile(bytes:Buffer|string, fn:(file:string)=>void){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-magic-')); const file=path.join(dir,'f.bin');
  try{fs.writeFileSync(file,bytes);fn(file);}finally{fs.rmSync(dir,{recursive:true,force:true});}
}

describe('uploadFileSafety comprehensive signature behavior',()=>{
  it('normalizes MIME case and covers every canonical storage extension class',()=>{
    const cases:Record<string,string>={
      'IMAGE/JPEG':'.jpg','image/png':'.png','image/gif':'.gif','image/webp':'.webp','image/svg+xml':'.svg','image/tiff':'.tiff','image/bmp':'.bmp',
      'application/pdf':'.pdf','text/plain':'.txt','text/markdown':'.md','text/csv':'.csv','application/msword':'.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx','application/vnd.ms-excel':'.xls','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx',
      'application/vnd.ms-powerpoint':'.ppt','application/vnd.openxmlformats-officedocument.presentationml.presentation':'.pptx','application/zip':'.zip','application/x-rar-compressed':'.rar',
      'application/x-7z-compressed':'.7z','application/x-tar':'.tar','application/gzip':'.gz','application/json':'.json','text/xml':'.xml','application/xml':'.xml',
      'audio/mpeg':'.mp3','audio/mp3':'.mp3','audio/ogg':'.ogg','audio/wav':'.wav','audio/x-wav':'.wav','audio/flac':'.flac','audio/aac':'.aac','audio/webm':'.webm','audio/mp4':'.m4a',
      'video/mp4':'.mp4','video/webm':'.webm','video/ogg':'.ogv','video/quicktime':'.mov','video/x-msvideo':'.avi',
    };
    for(const [mime,ext] of Object.entries(cases)) expect(canonicalExtensionForMime(mime)).toBe(ext);
    expect(canonicalExtensionForMime('application/x-nope')).toBeNull();
  });

  it.each([
    ['image/jpeg',Buffer.from([0xff,0xd8,0xff,0x00])],
    ['image/png',Buffer.from([0x89,0x50,0x4e,0x47])],
    ['image/gif',Buffer.from('GIF89a')],
    ['image/webp',Buffer.from('RIFFxxxxWEBP')],
    ['application/pdf',Buffer.from('%PDF-1.7')],
    ['application/zip',Buffer.from([0x50,0x4b,0x03,0x04])],
    ['application/zip',Buffer.from([0x50,0x4b,0x05,0x06])],
    ['application/zip',Buffer.from([0x50,0x4b,0x07,0x08])],
    ['audio/mpeg',Buffer.from('ID3\x04\x00','binary')],
    ['audio/mpeg',Buffer.from([0xff,0xe3,0,0])],
    ['audio/mp3',Buffer.from('ID3\x04\x00','binary')],
    ['audio/mp3',Buffer.from([0xff,0xe2,0,0])],
    ['audio/ogg',Buffer.from('OggS')],
    ['audio/wav',Buffer.from('RIFFxxxxWAVE')],
    ['audio/x-wav',Buffer.from('RIFFxxxxWAVE')],
    ['audio/flac',Buffer.from('fLaC')],
    ['audio/aac',Buffer.from([0xff,0xf0,0,0])],
    ['audio/webm',Buffer.from([0x1a,0x45,0xdf,0xa3])],
  ])('accepts valid fixed signature for %s',(mime,bytes)=>withFile(bytes,file=>expect(checkMagicBytes(file,mime)).toBe(true)));

  it.each([
    ['image/jpeg',Buffer.from([0xff,0xd8,0x00])],['image/png',Buffer.from('NOTPNG')],['image/gif',Buffer.from('BAD')],['image/webp',Buffer.from('RIFFxxxxNOPE')],
    ['application/pdf',Buffer.from('NOPE')],['application/zip',Buffer.from([0x50,0x4b,0x01,0x02])],['audio/mpeg',Buffer.from([0xff,0x00])],['audio/mp3',Buffer.from('NO3')],
    ['audio/ogg',Buffer.from('NOgg')],['audio/wav',Buffer.from('RIFFxxxxNOPE')],['audio/x-wav',Buffer.from('RIFFxxxxNOPE')],['audio/flac',Buffer.from('nope')],['audio/aac',Buffer.from([0xff,0x00])],['audio/webm',Buffer.from([0,1,2,3])],
  ])('rejects spoofed fixed signature for %s',(mime,bytes)=>withFile(bytes,file=>expect(checkMagicBytes(file,mime)).toBe(false)));

  it.each(['text/plain','text/markdown','text/csv','video/mp4','video/webm','video/ogg','video/quicktime','video/x-msvideo','application/json','application/xml','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/x-rar-compressed','application/x-7z-compressed','application/x-tar','application/gzip','image/svg+xml','image/tiff','image/bmp','audio/mp4'])('does not invent weak magic proof for parser/scanner-owned format %s',(mime)=>{
    expect(checkMagicBytes('/definitely/does/not/exist',mime)).toBe(true);
  });

  it('unknown MIME is compatibility-permitted while fixed-signature file IO failures fail closed',()=>{
    expect(checkMagicBytes('/missing','application/x-unknown')).toBe(true);
    expect(checkMagicBytes('/missing','image/png')).toBe(false);
    withFile(Buffer.alloc(0),file=>expect(checkMagicBytes(file,'image/png')).toBe(false));
  });

  it('still returns the signature verdict if closing the descriptor fails',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-close-')); const file=path.join(dir,'f.bin'); fs.writeFileSync(file,Buffer.from([0x89,0x50,0x4e,0x47]));
    const original=fs.closeSync; const spy=jest.spyOn(fs,'closeSync').mockImplementation((fd:any)=>{ original(fd); throw new Error('close fail'); });
    try{expect(checkMagicBytes(file,'image/png')).toBe(true);} finally{spy.mockRestore();fs.rmSync(dir,{recursive:true,force:true});}
  });
});
