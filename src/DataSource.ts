import defaults from 'lodash/defaults';

import {
  AnnotationEvent,
  AnnotationQueryRequest,
  DataQueryError,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  FieldType,
  MutableDataFrame,
} from '@grafana/data';

import { getBackendSrv } from '@grafana/runtime';

import { ChaosEvent, defaultQuery, ChaosEventsQuery, ChaosMeshOptions, ChaosEventsQueryResponse } from './types';

export class DataSource extends DataSourceApi<ChaosEventsQuery, ChaosMeshOptions> {
  url: string;
  defaultUrl: string;

  constructor(instanceSettings: DataSourceInstanceSettings<ChaosMeshOptions>) {
    super(instanceSettings);

    this.url = instanceSettings.url!;
    this.defaultUrl = instanceSettings.jsonData.defaultUrl;
  }

  _request(url: string, data: Record<string, string> = {}) {
    const options = {
      url: this.url + url,
      method: 'GET',
    };

    if (data && Object.keys(data).length) {
      options.url =
        options.url +
        '?' +
        Object.entries(data)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&');
    }

    return getBackendSrv().datasourceRequest(options);
  }

  checkLiveness() {
    const url = '/ping';

    return this._request(url).catch((err: any) => {
      console.error(err);
    });
  }

  queryNamespaces() {
    const url = '/api/common/namespaces';
    return this._request(url).catch((err: any) => {
      console.error(err);
    });
  }

  queryEvents(req: ChaosEventsQuery) {
    const url = '/api/events/dry';
    const data: any = {
      startTime: req.startTime,
      finishTime: req.finishTime,
      kind: req.kind,
    };

    if (req.experiment) {
      data.experimentName = req.experiment;
    }
    if (req.namespace) {
      data.experimentNamespace = req.namespace;
    }

    return this._request(url, data).catch((err: any) => {
      throw this.handleErrors(err, req);
    });
  }

  handleErrors = (err: any, target: ChaosEventsQuery) => {
    const error: DataQueryError = {
      message: (err && err.statusText) || 'Unknown error during query transaction. Please check JS console logs.',
      refId: target.refId,
    };

    if (err.data) {
      if (typeof err.data === 'string') {
        error.message = err.data;
      } else if (err.data.error) {
        error.message = this.safeStringifyValue(err.data.error);
      }
    } else if (err.message) {
      error.message = err.message;
    } else if (typeof err === 'string') {
      error.message = err;
    }

    error.status = err.status;
    error.statusText = err.statusText;

    return error;
  };

  safeStringifyValue = (value: any, space?: number) => {
    if (!value) {
      return '';
    }

    try {
      return JSON.stringify(value, null, space);
    } catch (error) {
      console.error(error);
    }

    return '';
  };

  async query(options: DataQueryRequest<ChaosEventsQuery>): Promise<DataQueryResponse> {
    const { range } = options;
    const from = this.toRFC3339TimeStamp(range.from.toDate());
    const to = this.toRFC3339TimeStamp(range.to.toDate());

    const data = options.targets.map(target => {
      const query = defaults(target, defaultQuery);
      query.startTime = from;
      query.finishTime = to;
      const frame = new MutableDataFrame({
        refId: query.refId,
        fields: [
          { name: 'Kind', type: FieldType.string },
          { name: 'Namespace', type: FieldType.string },
          { name: 'Experiment', type: FieldType.string },
          { name: 'Start Time', type: FieldType.time },
          { name: 'Finish Time', type: FieldType.time },
        ],
      });
      this.queryEvents(query).then((response: ChaosEventsQueryResponse) => {
        response.data.forEach(event => {
          const value: any = {};
          value.Kind = event.Kind;
          value['Start Time'] = event.StartTime;
          value['Finish Time'] = event.FinishTime;
          value.Namespace = event.Namespace;
          value.Experiment = event.Experiment;
          frame.add(value);
        });
      });
      return frame;
    });

    return { data };
  }

  // Stole this from http://cbas.pandion.im/2009/10/generating-rfc-3339-timestamps-in.html
  toRFC3339TimeStamp(date: Date) {
    function pad(amount: number, width: number) {
      let padding = '';
      while (padding.length < width - 1 && amount < Math.pow(10, width - padding.length - 1)) {
        padding += '0';
      }
      return padding + amount.toString();
    }
    let offset: number = date.getTimezoneOffset();
    return (
      pad(date.getFullYear(), 4) +
      '-' +
      pad(date.getMonth() + 1, 2) +
      '-' +
      pad(date.getDate(), 2) +
      'T' +
      pad(date.getHours(), 2) +
      ':' +
      pad(date.getMinutes(), 2) +
      ':' +
      pad(date.getSeconds(), 2) +
      '.' +
      pad(date.getMilliseconds(), 3) +
      (offset > 0 ? '-' : '+') +
      pad(Math.floor(Math.abs(offset) / 60), 2) +
      ':' +
      pad(Math.abs(offset) % 60, 2)
    );
  }

  async testDatasource() {
    // Implement a health check for your data source.

    const response = await this.checkLiveness();
    if (!response) {
      return { status: 'error', message: 'Cannot connect to Data source' };
    }
    return response.status === 200
      ? { status: 'success', message: 'Data source is working' }
      : { status: 'error', message: response.error };
  }

  async annotationQuery(options: AnnotationQueryRequest<ChaosEventsQuery>): Promise<AnnotationEvent[]> {
    const { range } = options;
    const query = defaults(options.annotation, defaultQuery);

    query.startTime = this.toRFC3339TimeStamp(range.from.toDate());
    query.finishTime = this.toRFC3339TimeStamp(range.to.toDate());
    const response: ChaosEventsQueryResponse = await this.queryEvents(query);

    return response.data.map((event: ChaosEvent) => {
      const eventPage = `${this.defaultUrl}/experiments/${event.Experiment}?namespace=${event.Namespace}&kind=${event.Kind}&event=${event.ID}`;
      const regionEvent: AnnotationEvent = {
        title: `${event.Experiment}`,
        time: Date.parse(event.StartTime),
        timeEnd: Date.parse(event.FinishTime),
        isRegion: true,
        text: `<a target="_blank" href=${eventPage}>Event Details</a>`,
        tags: [`kind:${event.Kind}`, `namespace:${event.Namespace}`],
      };
      return regionEvent;
    });
  }
}
