/* global angular */

(function () {
    'use strict';

    angular.module('qipp-services-resource', [])

        .provider('resource', function () {
            var $config = {
                host: '',
                prefix: '',
                suffix: '',
                actions: {
                    get: 'GET',
                    create: 'POST',
                    update: 'PATCH',
                    replace: 'PUT',
                    destroy: 'DELETE'
                },
                params: {},
                headers: {},
                handleRequest: angular.noop,
                handleResponse: function (resource, response) {
                    resource.$setData(response.data);
                }
            };
            this.defaults = $config;
            this.$get = [
                '$http',
                '$parse',
                '$q',
                'helper',
                'io',
                'pubsub',
                'relay',
                function (
                    $http,
                    $parse,
                    $q,
                    helper,
                    io,
                    pubsub,
                    relay
                ) {
                    var convertResourceParams = function (params, resource) {
                        // This method replaces parameter values starting
                        // with an "@" with their respective resource properties:
                        // params: {id: '@id', name: '@name'}
                        angular.forEach(params, function (value, key) {
                            if (value && value.charAt && value.charAt(0) === '@') {
                                params[key] = $parse(value.substr(1))(resource);
                            }
                        });
                    },
                    Resource = function (url, options) {
                        var that = this,
                            deferred = $q.defer();
                        deferred.resolve();
                        this.$promise = deferred.promise;
                        pubsub(this);
                        this.data = (options && options.data) || {};
                        this.options = helper.deepExtend(
                            {url: url},
                            $config,
                            options
                        );
                        // grab the access token from io service
                        this.accessToken = io.get('accessToken');
                        angular.forEach(
                            this.options.actions,
                            function (method, action) {
                                that['$' + action] = function (opts, returnOpts) {
                                    return that.$request(action, opts, returnOpts);
                                };
                            }
                        );
                    },
                    resourceFactory;
                    Resource.prototype.$getData = function () {
                        return this.data;
                    };
                    Resource.prototype.$setData = function (data) {
                        if (data) {
                            this.data = data;
                        }
                    };
                    Resource.prototype.$getAccessToken = function () {
                        return this.accessToken;
                    };
                    Resource.prototype.$request = function (action, opts, returnOpts) {
                        var that = this,
                            requestDeferred = $q.defer(),
                            eventEmitter = function () {
                                that.$emit(
                                    that.action + that.state,
                                    arguments
                                );
                            },
                            settings = this.options,
                            params = angular.extend(
                                {},
                                settings.params.common,
                                settings.params[action]
                            ),
                            // Any request to the API needs the bearer to be in the authorization header
                            oauthTokenHeaders = {
                                Authorization: 'Bearer ' + this.$getAccessToken()
                            },
                            headers = angular.extend(
                                {},
                                settings.headers.common,
                                settings.headers[action],
                                oauthTokenHeaders
                            ),
                            options = helper.deepExtend({
                                method: settings.actions[action],
                                data: angular.extend({}, this.$getData()),
                                params: params,
                                headers: headers,
                                withCredentials: settings.withCredentials
                            }, opts),
                            promise = requestDeferred.promise;
                        options.method = angular.uppercase(options.method);
                        // Only send body data for POST/PUT/PATCH requests:
                        if (options.method === 'DELETE') {
                            // If data is undefined, angular strips the Content-Type
                            // header and some browsers send DELETE requests by default
                            // as "application/xml", so we simply set it to an empty string:
                            options.data = '';
                        } else if (
                            options.method !== 'POST' &&
                            options.method !== 'PUT' &&
                            options.method !== 'PATCH'
                        ) {
                            delete options.data;
                        }
                        convertResourceParams(options.params, this);
                        options.url = helper.url(
                            settings.host + settings.prefix + settings.url + settings.suffix,
                            options.params
                        );
                        delete options.params;
                        // If the returnOpts argument is true,
                        // simply return the options object:
                        if (returnOpts) {
                            return options;
                        }
                        this.action = action;
                        this.state = 'pending';
                        settings.handleRequest(that, options);
                        eventEmitter(options);
                        // Create success and error states, same as the http method.
                        promise.success = function (cb) {
                            promise.then(cb);
                            return promise;
                        };
                        promise.error = function (cb) {
                            promise.then(null, cb);
                            return promise;
                        };
                        this.$promise = promise;
                        $http(options).then(
                            function (response) {
                                that.state = 'success';
                                settings.handleResponse(that, response);
                                requestDeferred.resolve(response.data);
                            },
                            function (response) {
                                // Shortcut method
                                function handle () {
                                    settings.handleResponse(that, response);
                                }
                                // Look after an unauthorized authentication,
                                // i.e. the access token is expired or invalid.
                                if (response.status === 401) {
                                    // Use auth through the relay service in order to avoid
                                    // a circular dependency as auth is already using authResource.
                                    relay.exec([
                                        'auth',
                                        function (service) {
                                            // Provide the request and the response as arguments.
                                            service
                                                .getNewAccessToken(that, response)
                                                .then(
                                                    function (data) {
                                                        response = data;
                                                        handle();
                                                        that.state = 'success';
                                                        requestDeferred.resolve(data);
                                                    },
                                                    function () {
                                                        handle();
                                                        that.state = 'error';
                                                        requestDeferred.reject();
                                                    }
                                                );
                                        }
                                    ]);
                                } else {
                                    handle();
                                    that.state = 'error';
                                    requestDeferred.reject();
                                }
                            }
                        );
                        return promise
                            .success(eventEmitter)
                            .error(eventEmitter);
                    };
                    resourceFactory = function (url, options) {
                        return new Resource(url, options);
                    };
                    resourceFactory.defaults = $config;
                    return resourceFactory;
                }
            ];
        })

        .provider('apiResource', function () {
            var $config = {
                host: undefined,
                prefix: '/',
                // Set the number of items to be displayed per page.
                itemsPerPage: 10
            };
            this.defaults = $config;
            this.$get = [
              'resource',
              'helper',
              'user',
                function (
                  resource,
                  helper,
                  user
                ) {
                    return function (url, options, ignorePaging) {
                        var rs,
                            regex = {
                                // Match '/api/v[0-∞]'
                                api: /^\/api\/v\d+\//,
                                // Match 'limit=[0-∞]'
                                limit: /limit=\d+/
                            },
                            prefix = $config.prefix;
                        // The ignorePaging boolean is used by the authResource
                        // in order to bypass the paging parameter.
                        // We also don't want to add another limit parameter.
                        if (!ignorePaging && !url.match(regex.limit)) {
                            options = helper.deepExtend({
                                params: {
                                    common: {
                                        limit: $config.itemsPerPage
                                    }
                                }
                            }, options);
                        }
                        // Remove the api prefix if one is already provided in the url.
                        // This could be the case with the paging service, with the links
                        // coming from the API, or if reaching a different API version is required.
                        if (url.match(regex.api)) {
                           prefix = '';
                        }
                        rs = resource(url, helper.deepExtend({
                            host: $config.host,
                            prefix: prefix,
                            handleRequest: function (resource, request) {
                                if (resource.form) {
                                    // Only send parameters that are defined as input
                                    // fields of the form tied to the resource:
                                    angular.forEach(request.data, function (value, key) {
                                        var prop;
                                        if (angular.isObject(value)) {
                                            // Check nested fields, which are stored in
                                            // flat form in the resource.form object:
                                            for (prop in value) {
                                                if (value.hasOwnProperty(prop) &&
                                                    angular.isDefined(
                                                        resource.form[key + '.' + prop]
                                                    )) {
                                                        return;
                                                    }
                                            }
                                        }
                                        if (angular.isUndefined(resource.form[key])) {
                                            delete request.data[key];
                                        }
                                    });
                                }
                            },
                            handleResponse: function (resource, response) {
                                /* jshint ignore:start */
                                // Either this method is called after a 401,
                                // or directly from the resource. As a consequence,
                                // the response data could be injected differently.
                                var data =
                                        response._embedded ?
                                        response :
                                        response.data;
                                if (data && data._embedded) {
                                    // Populate the resource with the data directly
                                    // or either with the embedded items.
                                    // We could detect it as a given response could have
                                    // an id, which that, in this case, the response root
                                    // must be the resource.data.
                                    resource.data =
                                        data.id ?
                                        data :
                                        data._embedded.items;
                                    // Store the links for further use.
                                    resource.links = data._links;
                                    /* jshint ignore:end */
                                    // Push the indexes as an enum property.
                                    resource.enum = {
                                        items: data.total,
                                        limit: data.limit,
                                        page: data.page,
                                        pages: data.pages
                                    };
                                }
                                resource.errors = data && data.errors;
                                if (!resource.errors && resource.state === 'error') {
                                    resource.errors = {status: [response.status]};
                                }
                            }
                        }, options));
                        rs.user = user;
                        return rs;
                    };
                }
            ];
        })

        .provider('authResource', function () {
            var $config = {
                host: undefined,
                prefix: '/'
            };
            this.defaults = $config;
            this.$get = [
                'apiResource',
                function (
                    apiResource
                ) {
                    return function (url, options) {
                        return apiResource(
                            url,
                            angular.extend({
                                host: $config.host,
                                prefix: $config.prefix,
                                withCredentials: true
                            }, options),
                            true // Set ignore paging
                        );
                    };
                }
            ];
        });

}());
