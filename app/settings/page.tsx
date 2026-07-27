"use client";

import React, { useState } from "react";
import { M365AuthProvider } from "@/components/M365AuthProvider";
import { Settings as SettingsIcon, MapPin, Clock, Save, CheckCircle2 } from "lucide-react";

function SettingsContent() {
  const [saved, setSaved] = useState(false);
  const [workLocation, setWorkLocation] = useState("199 หมู่ 2 ต.หนองโพ อ.ตาคลี จ.นครสวรรค์");
  const [homeLocation, setHomeLocation] = useState("55 หมู่บ้านสุขใจ");
  const [workHours, setWorkHours] = useState({ start: "09:00", end: "17:00" });

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 font-sans">
      <div className="max-w-xl mx-auto space-y-6">
        {/* Header */}
        <div className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 backdrop-blur-2xl text-center shadow-2xl">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-emerald-500/20">
            <SettingsIcon className="w-7 h-7 text-slate-950" />
          </div>
          <h1 className="text-xl font-bold mb-1">⚙️ ตั้งค่าทั่วไป (General Settings)</h1>
          <p className="text-xs text-slate-400">
            ตั้งค่าเวลาทำงาน สถานที่ทำงาน และบ้าน สำหรับวางแผนการเดินทางและแจ้งเตือนนัดหมาย
          </p>
        </div>

        <form onSubmit={handleSave} className="p-6 rounded-3xl bg-slate-900/80 border border-slate-800 backdrop-blur-2xl space-y-5">
          {/* Work hours */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-300 flex items-center gap-2">
              <Clock className="w-4 h-4 text-emerald-400" />
              เวลาเข้า-เลิกงาน (Working Hours)
            </label>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-[10px] text-slate-500">เวลาเริ่มงาน</span>
                <input
                  type="time"
                  value={workHours.start}
                  onChange={(e) => setWorkHours({ ...workHours, start: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <span className="text-[10px] text-slate-500">เวลาเลิกงาน</span>
                <input
                  type="time"
                  value={workHours.end}
                  onChange={(e) => setWorkHours({ ...workHours, end: e.target.value })}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          </div>

          {/* Locations */}
          <div className="space-y-3 pt-3 border-t border-slate-800">
            <div>
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-2 mb-1">
                <MapPin className="w-4 h-4 text-blue-400" />
                สถานที่ทำงาน (Work Location)
              </label>
              <input
                type="text"
                value={workLocation}
                onChange={(e) => setWorkLocation(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-slate-300 flex items-center gap-2 mb-1">
                <MapPin className="w-4 h-4 text-amber-400" />
                บ้าน / ที่พัก (Home Location)
              </label>
              <input
                type="text"
                value={homeLocation}
                onChange={(e) => setHomeLocation(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-emerald-500"
              />
            </div>
          </div>

          <button
            type="submit"
            className="w-full flex items-center justify-center gap-2 p-3.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs transition shadow-lg shadow-emerald-500/20"
          >
            {saved ? (
              <>
                <CheckCircle2 className="w-4 h-4" />
                บันทึกการตั้งค่าเรียบร้อยแล้ว!
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                บันทึกข้อมูล
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <M365AuthProvider>
      <SettingsContent />
    </M365AuthProvider>
  );
}
