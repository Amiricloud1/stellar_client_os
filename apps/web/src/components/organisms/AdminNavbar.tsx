"use client";

import { usePathname } from "next/navigation";
import Image from "next/image";

import { SidebarTrigger } from "@/components/ui/sidebar";
import NotificationIcon from "@/components/svgs/NotificationIcon";

const AdminNavbar = () => {
  const pathname = usePathname();
  const currentPath = pathname?.slice(1) || "Dashboard";

  return (
    <nav
      aria-label="Admin header navigation"
      className="py-3 px-3 md:px-5 flex justify-between items-center border-b border-b-fundable-mid-dark text-white"
    >
      <span className="flex items-center gap-x-2">
        <SidebarTrigger />
        <h2 className="hidden lg:block font-medium md:text-2xl font-bricolage capitalize">
          {currentPath}
        </h2>
      </span>
      <div className="flex items-center gap-x-4">
        <button
          type="button"
          aria-label="View notifications"
          className="size-12 min-h-[44px] min-w-[44px] hidden md:grid place-content-center rounded-full bg-fundable-mid-dark text-white hover:bg-fundable-mid-dark/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fundable-purple-2 transition-colors cursor-pointer"
        >
          <NotificationIcon />
        </button>
        {false ? (
          <div className="bg-gradient-to-r from-blue-500 via-purple-800 to-pink-500 rounded-sm px-2 md:px-3 py-1 md:py-2 text-sm font-medium flex gap-x-2 font-bricolage">
            <Image
              src={"/avatar.svg"}
              alt="Avatar"
              width={50}
              height={50}
              className="w-auto"
              priority
            />
            {"w01234hb4bjj"}
          </div>
        ) : null}
      </div>
    </nav>
  );
};

export default AdminNavbar;