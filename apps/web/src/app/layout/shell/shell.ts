import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { HlmSidebarImports } from '@ui/sidebar';
import { AppSidebar } from '../app-sidebar/app-sidebar';
import { TopBar } from '../top-bar/top-bar';

/** The signed-in layout: sidebar, then the top bar over the routed page. */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, HlmSidebarImports, AppSidebar, TopBar],
  template: `
    <div hlmSidebarWrapper>
      <app-sidebar />
      <main hlmSidebarInset>
        <app-top-bar />
        <div class="w-full max-w-6xl p-4 md:p-6"><router-outlet /></div>
      </main>
    </div>
  `,
})
export class Shell {}
