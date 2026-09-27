'use strict';
import { envSafeInt } from '../lib/envNumbers';

describe('envSafeInt',()=>{
  afterEach(()=>{ delete process.env.TEST_STRICT_INT; });
  it('uses fallback only when unset/blank and accepts bounded integers',()=>{
    delete process.env.TEST_STRICT_INT; expect(envSafeInt('TEST_STRICT_INT',7)).toBe(7);
    process.env.TEST_STRICT_INT='  '; expect(envSafeInt('TEST_STRICT_INT',7)).toBe(7);
    process.env.TEST_STRICT_INT='12'; expect(envSafeInt('TEST_STRICT_INT',7,{min:2,max:20})).toBe(12);
  });
  it.each(['-1','+1','1.5','10junk','1e3','NaN','Infinity'])(`rejects malformed %s`,(value)=>{
    process.env.TEST_STRICT_INT=value; expect(()=>envSafeInt('TEST_STRICT_INT',7)).toThrow(/integer/);
  });
  it('rejects zero/out-of-range/unsafe integers',()=>{
    process.env.TEST_STRICT_INT='0'; expect(()=>envSafeInt('TEST_STRICT_INT',7)).toThrow(/between/);
    process.env.TEST_STRICT_INT='21'; expect(()=>envSafeInt('TEST_STRICT_INT',7,{max:20})).toThrow(/between/);
    process.env.TEST_STRICT_INT=String(Number.MAX_SAFE_INTEGER+1); expect(()=>envSafeInt('TEST_STRICT_INT',7)).toThrow(/safe integer/);
  });
});
