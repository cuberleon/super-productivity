import { Injectable } from '@angular/core';
import { DROPBOX_APP_KEY } from './dropbox.const';
import { GlobalConfigService } from '../../../features/config/global-config.service';
import { first, map, switchMap, tap } from 'rxjs/operators';
import { DataInitService } from '../../../core/data-init/data-init.service';
import { Observable } from 'rxjs';
import axios, { AxiosResponse, Method } from 'axios';
import { stringify } from 'query-string';
import { DropboxFileMetadata } from './dropbox.model';
import { toDropboxIsoString } from './iso-date-without-ms.util.';
import { DialogGetAndEnterAuthCodeComponent } from '../dialog-get-and-enter-auth-code/dialog-get-and-enter-auth-code.component';
import { MatDialog } from '@angular/material/dialog';
import { T } from '../../../t.const';
import { SnackService } from '../../../core/snack/snack.service';
import { generatePKCECodes } from '../generate-pkce-codes';
import { Store } from '@ngrx/store';
import { updateGlobalConfigSection } from '../../../features/config/store/global-config.actions';
import { SyncConfig } from '../../../features/config/global-config.model';

@Injectable({ providedIn: 'root' })
export class DropboxApiService {
  private _accessToken$: Observable<string | null> = this._globalConfigService.cfg$.pipe(
    map((cfg) => cfg?.sync.dropboxSync.accessToken),
  );
  private _refreshToken$: Observable<string | null> = this._globalConfigService.cfg$.pipe(
    map((cfg) => cfg?.sync.dropboxSync.refreshToken),
  );

  isTokenAvailable$: Observable<boolean> = this._accessToken$.pipe(
    map((token) => !!token),
  );

  private _isReady$: Observable<boolean> =
    this._dataInitService.isAllDataLoadedInitially$.pipe(
      switchMap(() => this.isTokenAvailable$),
      tap((isTokenAvailable) => !isTokenAvailable && new Error('Dropbox API not ready')),
      first(),
    );

  constructor(
    private _globalConfigService: GlobalConfigService,
    private _dataInitService: DataInitService,
    private _matDialog: MatDialog,
    private _snackService: SnackService,
    private _store: Store,
  ) {}

  async getMetaData(path: string): Promise<DropboxFileMetadata> {
    await this._isReady$.toPromise();

    return this._request({
      method: 'POST',
      url: 'https://api.dropboxapi.com/2/files/get_metadata',
      data: { path },
    }).then((res) => res.data);
  }

  async download<T>({
    path,
    localRev,
  }: {
    path: string;
    localRev?: string | null;
  }): Promise<{ meta: DropboxFileMetadata; data: T }> {
    await this._isReady$.toPromise();

    return this._request({
      method: 'POST',
      url: 'https://content.dropboxapi.com/2/files/download',
      headers: {
        'Dropbox-API-Arg': JSON.stringify({ path }),
        // NOTE: doesn't do much, because we rarely get to the case where it would be
        // useful due to our pre meta checks and because data often changes after
        // we're checking it.
        // If it messes up => Check service worker!
        ...(localRev ? { 'If-None-Match': localRev } : {}),
        // circumvent:
        // https://github.com/angular/angular/issues/37133
        // https://github.com/johannesjo/super-productivity/issues/645
        // 'ngsw-bypass': true
      },
    }).then((res) => {
      const meta = JSON.parse(res.headers['dropbox-api-result']);
      return { meta, data: res.data };
    });
  }

  async upload({
    path,
    localRev,
    data,
    clientModified,
    isForceOverwrite = false,
  }: {
    path: string;
    clientModified?: number;
    localRev?: string | null;
    data: any;
    isForceOverwrite?: boolean;
  }): Promise<DropboxFileMetadata> {
    await this._isReady$.toPromise();

    const args = {
      mode: { '.tag': 'overwrite' },
      path,
      mute: true,
      ...(typeof clientModified === 'number'
        ? // we need to use ISO 8601 "combined date and time representation" format:
          { client_modified: toDropboxIsoString(clientModified) }
        : {}),
    };

    if (localRev && !isForceOverwrite) {
      args.mode = { '.tag': 'update', update: localRev } as any;
    }

    return this._request({
      method: 'POST',
      url: 'https://content.dropboxapi.com/2/files/upload',
      data,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': JSON.stringify(args),
      },
    }).then((res) => res.data);
  }

  async checkUser(accessToken: string): Promise<unknown> {
    await this._isReady$.toPromise();
    return this._request({
      accessToken,
      method: 'POST',
      url: 'https://api.dropboxapi.com/2/check/user',
    }).then((res) => res.data);
  }

  async _request({
    url,
    method = 'GET',
    data,
    headers = {},
    params,
    accessToken,
  }: {
    url: string;
    method?: Method;
    headers?: { [key: string]: any };
    data?: string | Record<string, unknown>;
    params?: { [key: string]: string };
    accessToken?: string;
  }): Promise<AxiosResponse> {
    await this._isReady$.toPromise();
    accessToken =
      accessToken || (await this._accessToken$.pipe(first()).toPromise()) || undefined;
    return axios.request({
      url: params && Object.keys(params).length ? `${url}?${stringify(params)}` : url,
      method,
      data,
      headers: {
        authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json;charset=UTF-8',
        ...headers,
      },
    });
  }

  async getAccessTokenViaDialog(): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } | null> {
    const { codeVerifier, codeChallenge } = await generatePKCECodes(128);
    const DROPBOX_AUTH_CODE_URL =
      `https://www.dropbox.com/oauth2/authorize` +
      `?response_type=code&client_id=${DROPBOX_APP_KEY}` +
      '&code_challenge_method=S256' +
      '&token_access_type=offline' +
      `&code_challenge=${codeChallenge}`;

    const authCode = await this._matDialog
      .open(DialogGetAndEnterAuthCodeComponent, {
        restoreFocus: true,
        data: {
          providerName: 'Dropbox',
          url: DROPBOX_AUTH_CODE_URL,
        },
      })
      .afterClosed()
      .toPromise();
    return this._getTokensFromAuthCode(authCode, codeVerifier);
  }

  // TODO add real type
  async updateAccessTokenFromRefreshTokenIfAvailable(): Promise<
    'SUCCESS' | 'NO_REFRESH_TOKEN' | 'ERROR'
  > {
    const refreshToken =
      (await this._refreshToken$.pipe(first()).toPromise()) || undefined;
    if (!refreshToken) {
      console.error('Dropbox: No refresh token available');
      return 'NO_REFRESH_TOKEN';
    }

    return axios
      .request({
        url: 'https://api.dropbox.com/oauth2/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        data: stringify({
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
          client_id: DROPBOX_APP_KEY,
        }),
      })
      .then(async (res) => {
        const sync = await this._globalConfigService.sync$.pipe(first()).toPromise();
        this._store.dispatch(
          updateGlobalConfigSection({
            isSkipLastActiveUpdate: true,
            sectionKey: 'sync',
            sectionCfg: {
              ...sync,
              dropboxSync: {
                ...sync.dropboxSync,
                accessToken: res.data.access_token,
                // eslint-disable-next-line no-mixed-operators
                _tokenExpiresAt: +res.data.expires_at * 1000 + Date.now(),
              },
            } as SyncConfig,
          }),
        );
        return 'SUCCESS' as any;
      })
      .catch((e) => {
        console.error(e);
        return 'ERROR';
      });
  }

  private async _getTokensFromAuthCode(
    authCode: string,
    codeVerifier: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } | null> {
    return axios
      .request({
        url: 'https://api.dropboxapi.com/oauth2/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        data: stringify({
          code: authCode,
          grant_type: 'authorization_code',
          client_id: DROPBOX_APP_KEY,
          code_verifier: codeVerifier,
        }),
      })
      .then((res) => {
        this._snackService.open({
          type: 'SUCCESS',
          msg: T.F.DROPBOX.S.ACCESS_TOKEN_GENERATED,
        });

        if (typeof res.data.access_token !== 'string') {
          console.log(res);
          throw new Error('Dropbox: Invalid access token response');
        }
        if (typeof res.data.refresh_token !== 'string') {
          console.log(res);
          throw new Error('Dropbox: Invalid refresh token response');
        }
        if (typeof +res.data.expires_in !== 'number') {
          console.log(res);
          throw new Error('Dropbox: Invalid expiresIn response');
        }

        return {
          accessToken: res.data.access_token as string,
          refreshToken: res.data.refresh_token as string,
          // eslint-disable-next-line no-mixed-operators
          expiresAt: +res.data.expires_in * 1000 + Date.now(),
        };
        // Not necessary as it is highly unlikely that we get a wrong on
        // const accessToken = res.data.access_token;
        // return this.checkUser(accessToken).then(() => accessToken);
      })
      .catch((e) => {
        console.error(e);
        this._snackService.open({
          type: 'ERROR',
          msg: T.F.DROPBOX.S.ACCESS_TOKEN_ERROR,
        });
        return null;
      });
  }
}
