import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

/**
 * DocsController — 运行时读 docs/ 目录, 支持热更新 (改文件不需要 rebuild)
 *
 * 安全设计:
 *   - 路径 sanitize: 所有 req.query.path 都要通过 resolvedPath.startsWith(docsRoot) 检查, 防止 ../ 越界
 *   - 只读 .md 文件, 拒绝其他扩展名
 *   - 单文件大小上限 5MB (防内存爆)
 *   - Tree 深度上限 5 层 (防递归过深)
 */
export class DocsController {
  private docsRoot: string;
  private static readonly MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  private static readonly MAX_DEPTH = 5;

  constructor() {
    // backend cwd = /opt/stocks/current/backend/ → docs 在 ../docs/
    // 本地开发 cwd = /path/to/stocks/backend/ → 同上
    this.docsRoot = path.resolve(process.cwd(), '..', 'docs');
  }

  /**
   * 判断路径是否在 docsRoot 内 (防越界)
   */
  private isPathSafe(targetPath: string): boolean {
    const resolved = path.resolve(targetPath);
    return resolved.startsWith(this.docsRoot + path.sep) || resolved === this.docsRoot;
  }

  /**
   * @desc 获取 docs/ 目录树 (递归, 只列出 .md 文件和子目录)
   * GET /api/docs/tree
   */
  getTree = async (_req: Request, res: Response): Promise<void> => {
    try {
      if (!fs.existsSync(this.docsRoot)) {
        res.json({ success: true, data: { name: 'docs', type: 'dir', path: '.', children: [] } });
        return;
      }

      const tree = this.buildTree(this.docsRoot, 0);
      res.json({ success: true, data: tree });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, message: `读取文档树失败: ${msg}` });
    }
  };

  /**
   * 递归构建目录树
   * 返回: { name, type: 'dir'|'file', path: relative, children?: [], size?, mtime? }
   */
  private buildTree(dirPath: string, depth: number): any {
    const stats = fs.statSync(dirPath);
    const relativePath = path.relative(this.docsRoot, dirPath) || '.';

    if (stats.isFile()) {
      // 只列 .md
      if (!dirPath.endsWith('.md')) return null;
      return {
        name: path.basename(dirPath),
        type: 'file',
        path: relativePath,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
      };
    }

    // 目录
    if (depth >= DocsController.MAX_DEPTH) {
      return {
        name: path.basename(dirPath) || 'docs',
        type: 'dir',
        path: relativePath,
        children: [],
        note: 'max depth reached',
      };
    }

    const entries = fs.readdirSync(dirPath);
    const children = entries
      .filter(e => !e.startsWith('.') && e !== 'node_modules') // 忽略隐藏和 node_modules
      .map(e => this.buildTree(path.join(dirPath, e), depth + 1))
      .filter(n => n !== null)
      .sort((a, b) => {
        // 目录在前, 文件在后; 各自按名字排序
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    return {
      name: path.basename(dirPath) || 'docs',
      type: 'dir',
      path: relativePath,
      children,
    };
  }

  /**
   * @desc 读取单个 markdown 文件
   * GET /api/docs/file?path=xxx/yyy.md
   */
  getFile = async (req: Request, res: Response): Promise<void> => {
    try {
      const requestedPath = (req.query.path as string) || '';

      if (!requestedPath) {
        res.status(400).json({ success: false, message: 'path 参数必填' });
        return;
      }

      // 只允许 .md 文件
      if (!requestedPath.endsWith('.md')) {
        res.status(400).json({ success: false, message: '只允许读取 .md 文件' });
        return;
      }

      const fullPath = path.join(this.docsRoot, requestedPath);

      // 安全检查: 必须在 docsRoot 内
      if (!this.isPathSafe(fullPath)) {
        res.status(403).json({ success: false, message: '路径越界, 拒绝访问' });
        return;
      }

      if (!fs.existsSync(fullPath)) {
        res.status(404).json({ success: false, message: '文档不存在' });
        return;
      }

      const stats = fs.statSync(fullPath);
      if (!stats.isFile()) {
        res.status(400).json({ success: false, message: '路径不是文件' });
        return;
      }

      if (stats.size > DocsController.MAX_FILE_SIZE) {
        res
          .status(413)
          .json({ success: false, message: `文件过大 (>${DocsController.MAX_FILE_SIZE} bytes)` });
        return;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      res.json({
        success: true,
        data: {
          path: requestedPath,
          content,
          size: stats.size,
          mtime: stats.mtime.toISOString(),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, message: `读取文档失败: ${msg}` });
    }
  };
}
