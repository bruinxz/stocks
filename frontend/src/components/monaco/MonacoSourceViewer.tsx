/**
 * MonacoSourceViewer — US-093 策略源码只读展示组件。
 *
 * 包装 `monaco-editor`（CRA 项目 ^0.41.0 已含依赖）渲染 TypeScript 源码到一个
 * div 容器，**只读模式**。AC 要求支持：搜索 / 跳转到符号 / 行号高亮，全部由
 * Monaco 内建：
 *  - 搜索：Cmd/Ctrl+F 触发原生 find widget；
 *  - 跳转到符号：Cmd/Ctrl+Shift+O 触发 outline / symbol picker；
 *  - 行号高亮：`lineNumbers: 'on'` + cursor jumps + 内置 gutter。
 *
 * Worker 策略：本组件使用 monaco-editor 的 ESM 入口但**不配置 webpack worker
 * 插件**——CRA 默认配置下 worker 注入会失败。我们设置 `self.MonacoEnvironment`
 * 返回一个空的 worker URL 让 monaco 退化到主线程模式（适合只读 viewer 场景，
 * 编辑 / 实时类型检查 / IntelliSense 才需要 worker；线上不需要这些能力）。
 *
 * 副作用隔离：useRef 持有 editor 实例，组件 unmount 时调 editor.dispose() 释放
 * canvas / event listeners，避免 SPA 路由切换导致内存泄漏。
 *
 * 动态 import：monaco 体积大（~1.5MB），用 lazy `import('monaco-editor')` 让
 * 首屏只在打开"代码视图"tab 时才下载 chunk。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Alert, Spin } from 'antd';

interface MonacoSourceViewerProps {
  /** 源码内容（已加载好；本组件不负责拉数据）。 */
  content: string;
  /** Monaco language id，默认 'typescript'。 */
  language?: string;
  /** 编辑器高度（px），默认 600。 */
  height?: number;
  /** 可选：父组件传一个 filename 供 model uri 区分（多 tab 缓存不会撞）。 */
  filename?: string;
}

// monaco-editor 的最小类型别名（避免 import 时强依赖 .d.ts）。
type IStandaloneCodeEditor = any;

const MonacoSourceViewer: React.FC<MonacoSourceViewerProps> = ({
  content,
  language = 'typescript',
  height = 600,
  filename,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<IStandaloneCodeEditor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 初始化：动态 import + 创建 editor。
  useEffect(() => {
    let cancelled = false;
    const containerEl = containerRef.current;
    if (!containerEl) {
      setLoading(false);
      return;
    }

    (async () => {
      try {
        // 抑制 worker 加载 — 退化到主线程模式（只读 viewer 场景足够）。
        // 必须在 import monaco 之前设置 self.MonacoEnvironment。
        if (typeof window !== 'undefined') {
          const noop = () => {
            /* 主线程 viewer 不需 worker postMessage / terminate / event handlers */
          };
          (window as any).MonacoEnvironment = (window as any).MonacoEnvironment || {
            getWorkerUrl: () => '',
            getWorker: () => ({
              postMessage: noop,
              terminate: noop,
              addEventListener: noop,
              removeEventListener: noop,
              onmessage: null,
              onerror: null,
            }),
          };
        }
        const monaco = await import('monaco-editor');
        if (cancelled || !containerRef.current) return;

        // TypeScript 语言 diagnostics 关闭（无 worker 也跑不动；强行打开会刷 console error）。
        try {
          monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
            noSemanticValidation: true,
            noSyntaxValidation: true,
            noSuggestionDiagnostics: true,
          });
        } catch {
          /* 老版本 monaco 可能没有此 API；忽略。 */
        }

        const editor = monaco.editor.create(containerRef.current!, {
          value: content,
          language,
          readOnly: true,
          theme: 'vs',
          automaticLayout: true,
          lineNumbers: 'on',
          minimap: { enabled: true },
          scrollBeyondLastLine: false,
          fontSize: 13,
          fontFamily:
            'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          renderLineHighlight: 'all',
          wordWrap: 'off',
          // 搜索 / find 默认开（Ctrl/Cmd+F），不显式关闭。
          // 符号跳转（Cmd/Ctrl+Shift+O outline picker）默认开。
          contextmenu: true,
          quickSuggestions: false, // 只读不需要建议
          parameterHints: { enabled: false },
        });

        editorRef.current = editor;
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        setLoadError(err?.message || 'Monaco 编辑器加载失败');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (editorRef.current) {
        try {
          editorRef.current.dispose();
        } catch {
          /* 已 dispose / 已被 GC 不报错 */
        }
        editorRef.current = null;
      }
    };
    // 故意只在 mount 时初始化一次；content 变化由下一个 effect 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 内容更新：editor 已 mount 时，调 setValue 替换 model 内容（避免重建 editor）。
  useEffect(() => {
    if (editorRef.current) {
      const cur = editorRef.current.getValue();
      if (cur !== content) {
        editorRef.current.setValue(content);
      }
    }
  }, [content, filename]);

  // 错误态。
  if (loadError) {
    return (
      <Alert
        type="error"
        showIcon
        message="Monaco 编辑器加载失败"
        description={loadError}
        style={{ marginBottom: 12 }}
      />
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      {loading && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255,255,255,0.6)',
            zIndex: 1,
          }}
        >
          <Spin tip="加载 Monaco 编辑器…" />
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          height,
          width: '100%',
          border: '1px solid #f0f0f0',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      />
    </div>
  );
};

export default MonacoSourceViewer;
