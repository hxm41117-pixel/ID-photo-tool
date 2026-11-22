import { Archive, FileText, FolderOpen, PlusCircle, X } from 'lucide-react';

interface WeChatSaveGuideProps {
  open: boolean;
  onClose: () => void;
  onDownloadZip?: () => void;
}

export function WeChatSaveGuide({ open, onClose, onDownloadZip }: WeChatSaveGuideProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 p-3 sm:p-5 pointer-events-none flex justify-center">
      <div className="pointer-events-auto w-full max-w-lg bg-white border border-slate-200 shadow-2xl shadow-slate-900/12 rounded-2xl p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              发微信防压缩方法（保留原图画质与 DPI）
            </h3>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">
              直接发相册图会被微信压缩，发送时请点聊天框右下角{' '}
              <span className="font-medium text-slate-800">+</span> →{' '}
              <span className="font-medium text-slate-800">文件</span> → 左上角切换
              <span className="font-medium text-slate-800">「手机相册」</span>选图
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭防压缩提示"
            className="p-1.5 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-2 mt-3.5">
          <div className="bg-slate-50 border border-slate-200/70 rounded-xl p-2.5 text-center">
            <div className="w-7 h-7 mx-auto rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-700 mb-1.5">
              <PlusCircle className="w-4 h-4" />
            </div>
            <div className="text-[11px] font-medium text-slate-800">1. 点右下角 +</div>
            <div className="text-[10px] text-slate-500 mt-0.5">进入聊天功能栏</div>
          </div>

          <div className="bg-slate-50 border border-slate-200/70 rounded-xl p-2.5 text-center">
            <div className="w-7 h-7 mx-auto rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-700 mb-1.5">
              <FileText className="w-4 h-4" />
            </div>
            <div className="text-[11px] font-medium text-slate-800">2. 选择「文件」</div>
            <div className="text-[10px] text-slate-500 mt-0.5">不走普通图片通道</div>
          </div>

          <div className="bg-slate-50 border border-slate-200/70 rounded-xl p-2.5 text-center">
            <div className="w-7 h-7 mx-auto rounded-lg bg-white border border-slate-200 flex items-center justify-center text-slate-700 mb-1.5">
              <FolderOpen className="w-4 h-4" />
            </div>
            <div className="text-[11px] font-medium text-slate-800">3. 切「手机相册」</div>
            <div className="text-[10px] text-slate-500 mt-0.5">选中证件照发送</div>
          </div>
        </div>

        {onDownloadZip && (
          <div className="mt-3.5 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
            <span className="text-[11px] text-slate-500">
              也可打包成 ZIP 发送，完全绕过平台二次压缩
            </span>
            <button
              type="button"
              onClick={onDownloadZip}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 active:scale-[0.98] transition-all shrink-0"
            >
              <Archive className="w-3.5 h-3.5" />
              打包防压缩 (.zip)
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
