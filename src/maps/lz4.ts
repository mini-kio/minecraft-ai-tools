import { fail } from '../contracts.js';

const PRIME1=0x9e3779b1,PRIME2=0x85ebca77,PRIME3=0xc2b2ae3d,PRIME4=0x27d4eb2f,PRIME5=0x165667b1;
const rot=(n:number,bits:number)=>(n<<bits)|(n>>>(32-bits));
/** XXH32 used by the lz4-java block stream (Minecraft's region type 4). */
export function xxhash32(input:Buffer,seed=0x9747b28c):number{
  let p=0,h:number;
  const round=(v:number,n:number)=>Math.imul(rot((v+Math.imul(n,PRIME2))|0,13),PRIME1);
  if(input.length>=16){let a=(seed+PRIME1+PRIME2)|0,b=(seed+PRIME2)|0,c=seed|0,d=(seed-PRIME1)|0;while(p<=input.length-16){a=round(a,input.readUInt32LE(p));b=round(b,input.readUInt32LE(p+4));c=round(c,input.readUInt32LE(p+8));d=round(d,input.readUInt32LE(p+12));p+=16;}h=(rot(a,1)+rot(b,7)+rot(c,12)+rot(d,18))|0;}else h=(seed+PRIME5)|0;
  h=(h+input.length)|0;while(p<=input.length-4){h=Math.imul(rot((h+Math.imul(input.readUInt32LE(p),PRIME3))|0,17),PRIME4);p+=4;}while(p<input.length){h=Math.imul(rot((h+Math.imul(input[p++],PRIME5))|0,11),PRIME1);}h^=h>>>15;h=Math.imul(h,PRIME2);h^=h>>>13;h=Math.imul(h,PRIME3);return(h^(h>>>16))>>>0;
}
function block(input:Buffer,length:number):Buffer{
  const out=Buffer.allocUnsafe(length);let p=0,q=0;
  const extended=(base:number)=>{let value=base;if(base===15){let n:number;do{if(p>=input.length)fail('INVALID_LZ4','Truncated LZ4 length');n=input[p++];value+=n;}while(n===255);}return value;};
  while(p<input.length){const token=input[p++],literal=extended(token>>>4);if(p+literal>input.length||q+literal>length)fail('INVALID_LZ4','LZ4 literal exceeds its block');input.copy(out,q,p,p+literal);p+=literal;q+=literal;if(p===input.length)break;if(p+2>input.length)fail('INVALID_LZ4','Truncated LZ4 match');const offset=input.readUInt16LE(p);p+=2;const count=extended(token&15)+4;if(!offset||offset>q||q+count>length)fail('INVALID_LZ4','Invalid LZ4 match offset or length');for(let i=0;i<count;i++)out[q+i]=out[q+i-offset];q+=count;}
  if(q!==length)fail('INVALID_LZ4','LZ4 decompressed size differs from its header');return out;
}
/** Bounded lz4-java LZ4BlockInputStream framing, including its masked XXH32 checksum. */
export function decodeAnvilLz4(input:Buffer,maxOutput=128*1024*1024):Buffer{
  const chunks:Buffer[]=[];let p=0,total=0,terminated=false;
  while(p<input.length){if(p+21>input.length||input.toString('ascii',p,p+8)!=='LZ4Block')fail('INVALID_LZ4','Invalid or truncated LZ4 block header');const token=input[p+8],method=token&0xf0,compressed=input.readUInt32LE(p+9),original=input.readUInt32LE(p+13),checksum=input.readUInt32LE(p+17);p+=21;
    if(![0x10,0x20].includes(method)||original>2**((token&15)+10)||compressed>original||p+compressed>input.length)fail('INVALID_LZ4','Invalid LZ4 block sizes or method');
    if(!compressed&&!original){if(checksum)fail('INVALID_LZ4','Invalid LZ4 terminator checksum');terminated=true;break;}if(!compressed||!original||total+original>maxOutput)fail('INVALID_LZ4','LZ4 output exceeds its bound');
    const payload=input.subarray(p,p+compressed);p+=compressed;if(method===0x10&&compressed!==original)fail('INVALID_LZ4','Raw LZ4 block sizes differ');const data=method===0x10?Buffer.from(payload):block(payload,original);if((xxhash32(data)&0x0fffffff)!==checksum)fail('INVALID_LZ4','LZ4 checksum mismatch');chunks.push(data);total+=original;
  }
  if(!terminated||p!==input.length)fail('INVALID_LZ4','Missing LZ4 terminator or unexpected trailing data');return Buffer.concat(chunks,total);
}
