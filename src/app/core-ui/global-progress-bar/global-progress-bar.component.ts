import {ChangeDetectionStrategy, Component} from '@angular/core';
import {GlobalProgressBarService} from './global-progress-bar.service';
import {fadeAnimation, fadeInOutTopAnimation} from '../../ui/animations/fade.ani';

@Component({
  selector: 'global-progress-bar',
  templateUrl: './global-progress-bar.component.html',
  styleUrls: ['./global-progress-bar.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  animations: [fadeAnimation, fadeInOutTopAnimation]
})
export class GlobalProgressBarComponent {
  constructor(
    public globalProgressBarService: GlobalProgressBarService,
  ) {
  }
}
