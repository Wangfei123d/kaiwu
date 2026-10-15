// 把 git 对象库里捞回的字节**逐字节**写回仓库(不用 shell 管道:引号/换行会毁掉内容)。
import fs from 'node:fs';

const SRC = 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\recovered';
const pairs = [
    ['kaiwu__app__lib__agent-stream.js', 'app/lib/agent-stream.js'],
    ['kaiwu__tests__markdown-nodes.test.js', 'tests/markdown-nodes.test.js'],
    ['kaiwu__tests__notes-view.test.js', 'tests/notes-view.test.js'],
];

for (const [src, dst] of pairs) {
    const buf = fs.readFileSync(`${SRC}\\${src}`);
    fs.writeFileSync(dst, buf);
    const first = buf.subarray(0, 40).toString('utf8').split('\n')[0];
    console.log(`写回 ${dst}  ${buf.length} 字节 | 首行: ${first}`);
}
