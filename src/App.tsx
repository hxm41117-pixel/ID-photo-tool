import { useState } from 'react';
import { ArrowLeftRight, IdCard, ShieldCheck } from 'lucide-react';
import { AppTab } from './types';
import { FormatConverter } from './components/FormatConverter';
import { IdPhotoStudio } from './components/IdPhotoStudio';
import { WeChatBanner } from './components/WeChatBanner';

export function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('id-photo');

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F5F7] text-slate-900">
      <WeChatBanner />

      {/* Top Navigation & Dual-Tab Switcher (sticky on tablet/PC, scrolls away on mobile so preview canvas can stick at top-0) */}
      <header className="md:sticky md:top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200/80">
        <div className="max-w-5xl mx-auto px-4 h-14 sm:h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-slate-900 text-white flex items-center justify-center shrink-0">
              <IdCard className="w-4 h-4" />
            </div>
            <div className="truncate">
              <h1 className="text-sm sm:text-base font-semibold text-slate-900 tracking-tight truncate">
                极简证件照工具箱
              </h1>
            </div>
          </div>

          {/* Dual Tab Switcher */}
          <nav
            aria-label="功能切换"
            className="inline-flex items-center bg-slate-100 p-1 rounded-xl border border-slate-200/70 shrink-0"
          >
            <button
              type="button"
              onClick={() => setActiveTab('id-photo')}
              className={`inline-flex items-center gap-1.5 px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
                activeTab === 'id-photo'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <IdCard className="w-3.5 h-3.5 hidden sm:block" />
              证件照制作
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('converter')}
              className={`inline-flex items-center gap-1.5 px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all ${
                activeTab === 'converter'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <ArrowLeftRight className="w-3.5 h-3.5 hidden sm:block" />
              图片转格式
            </button>
          </nav>

          {/* Subtle privacy indicator on wider screens */}
          <div className="hidden md:inline-flex items-center gap-1.5 text-xs text-slate-500 shrink-0">
            <ShieldCheck className="w-4 h-4 text-emerald-600" />
            <span>纯本地处理 · 零上传</span>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-5 sm:py-7">
        {activeTab === 'id-photo' ? <IdPhotoStudio /> : <FormatConverter />}
      </main>

      {/* Minimal Footer */}
      <footer className="py-6 text-center text-xs text-slate-400">
        所有抠图、DPI 写入、压缩与排版均在您的设备本地完成，不经过任何服务器。
      </footer>
    </div>
  );
}

export default App;
